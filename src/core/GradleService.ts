import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';

import { AndroidSDKManager } from './AndroidSDKManager';
import { findProjectRoot as utilFindProjectRoot, isProjectRoot } from '../utils/projectUtils';

/**
 * 执行 Gradle 任务和管理 Android 项目构建的服务。
 */
export class GradleService {
    private outputChannel: vscode.OutputChannel;
    private sdkManager: AndroidSDKManager;

    constructor(sdkManager: AndroidSDKManager) {
        this.outputChannel = vscode.window.createOutputChannel('Gradle');
        this.sdkManager = sdkManager;
    }

    /**
     * 查找 Android 项目根目录。
     * 委托给共享工具函数。
     */
    public findProjectRoot(): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('未找到工作区目录');
        }
        return utilFindProjectRoot(workspaceFolder.uri.fsPath);
    }

    /**
     * 判断目录是否为 Gradle 项目根
     */
    public isProjectRoot(dirPath: string): boolean {
        return isProjectRoot(dirPath);
    }

    /**
     * 获取 Gradle Wrapper 路径，并确保 Unix 系统上有执行权限
     */
    private getGradlewPath(projectRoot: string): string {
        const isWindows = os.platform() === 'win32';
        const wrapperBat = path.join(projectRoot, 'gradlew.bat');
        const wrapperShell = path.join(projectRoot, 'gradlew');

        if (isWindows) {
            if (fs.existsSync(wrapperBat)) {
                return wrapperBat;
            }
            if (fs.existsSync(wrapperShell)) {
                return wrapperShell;
            }
        } else {
            if (fs.existsSync(wrapperShell)) {
                // 确保 gradlew 可执行（对首次克隆的项目很重要）
                try {
                    fs.chmodSync(wrapperShell, 0o755);
                } catch { /* 静默忽略权限设置失败 */ }
                return wrapperShell;
            }
        }

        throw new Error(`在 ${projectRoot} 中未找到 Gradle wrapper。请确认你在 Android 项目目录中。`);
    }

    private targetModule: string | null = null;

    /**
     * 设置目标模块
     * @param module 模块名（如 ':app'），null 表示根项目
     */
    setTargetModule(module: string | null) {
        this.targetModule = (module === '(项目根目录)') ? null : module;
    }

    /**
     * 获取当前目标模块
     */
    getTargetModule(): string | null {
        return this.targetModule;
    }

    /**
     * 执行 Gradle 任务
     */
    async executeGradleTask(task: string, showOutput: boolean = true, timeoutMs: number = 600000): Promise<string> {
        const projectRoot = this.findProjectRoot();
        const gradlew = this.getGradlewPath(projectRoot);

        // 若设置了模块则添加模块前缀
        let finalTask = task;
        if (this.targetModule && !task.startsWith(':') && !task.includes(' ')) {
            finalTask = `${this.targetModule}:${task}`;
        }

        if (showOutput) {
            this.outputChannel.show(true);
            this.outputChannel.appendLine(`正在执行: ${finalTask}`);
            if (this.targetModule) {
                this.outputChannel.appendLine(`目标模块: ${this.targetModule}`);
            }
            this.outputChannel.appendLine(`项目根目录: ${projectRoot}`);
            this.outputChannel.appendLine('='.repeat(50));
        }

        await this.ensureLocalProperties(projectRoot);

        // 将任务字符串拆分为参数数组（避免 shell 拼接导致中文乱码）
        const taskArgs = finalTask.split(' ').filter(s => s.length > 0);

        // 确定可执行文件和参数列表
        let executable: string;
        let args: string[];

        if (os.platform() === 'win32' && !gradlew.endsWith('.bat')) {
            const jarPath = path.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
            if (fs.existsSync(jarPath)) {
                // 使用 Java 直接运行 Gradle Wrapper（完全绕开 cmd.exe）
                executable = 'java';
                args = [
                    '-Dorg.gradle.appname=gradlew',
                    '-cp', jarPath,
                    'org.gradle.wrapper.GradleWrapperMain',
                    ...taskArgs
                ];
                if (showOutput) this.outputChannel.appendLine('通过 Java 运行 Gradle（Windows 兼容模式）');
            } else {
                await this.ensureUnixLineEndings(gradlew);
                executable = 'bash';
                args = [gradlew, ...taskArgs];
            }
        } else if (os.platform() === 'win32' && gradlew.endsWith('.bat')) {
            executable = 'cmd.exe';
            args = ['/c', gradlew, ...taskArgs];
        } else {
            executable = gradlew;
            args = taskArgs;
        }

        return new Promise<string>((resolve, reject) => {
            const proc = spawn(executable, args, {
                cwd: projectRoot,
                env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME }
            });

            let stdout = '';
            let stderr = '';

            const timeoutTimer = setTimeout(() => {
                proc.kill();
                reject(new Error(`Gradle 任务超时 (${timeoutMs / 1000}秒): ${finalTask}`));
            }, timeoutMs);

            proc.stdout?.on('data', (data: Buffer) => {
                const text = data.toString();
                stdout += text;
                if (showOutput) {
                    this.outputChannel.append(text);
                }
            });

            proc.stderr?.on('data', (data: Buffer) => {
                const text = data.toString();
                stderr += text;
                if (showOutput) {
                    this.outputChannel.append(text);
                }
            });

            proc.on('close', (code) => {
                clearTimeout(timeoutTimer);
                if (showOutput) {
                    this.outputChannel.appendLine('');
                    this.outputChannel.appendLine('='.repeat(50));
                }
                if (code === 0) {
                    if (showOutput) this.outputChannel.appendLine('任务已完成！');
                    resolve(stdout);
                } else {
                    if (showOutput) this.outputChannel.appendLine(`任务失败！(退出码: ${code})`);
                    reject(new Error(`Gradle 任务失败，退出码 ${code}: ${finalTask}`));
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timeoutTimer);
                reject(new Error(`无法启动 Gradle 进程: ${err.message}`));
            });
        });
    }

    /**
     * 构建 Debug APK
     */
    async buildDebug(): Promise<string> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在构建 Debug APK...',
            cancellable: false
        }, async () => {
            return await this.executeGradleTask('assembleDebug');
        });
    }

    /**
     * 构建 Release APK（无签名配置时使用 Android 默认 debug keystore 作为后备）
     */
    async buildRelease(): Promise<string> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在构建 Release APK...',
            cancellable: false
        }, async () => {
            const projectRoot = this.findProjectRoot();
            const props = this.detectSigningPropertyNames(projectRoot);

            const debugKeystore = path.join(
                os.homedir(),
                '.android',
                'debug.keystore'
            );

            if (fs.existsSync(debugKeystore)) {
                const signingArgs = [
                    `-P${props.storeFile}=${debugKeystore}`,
                    `-P${props.storePassword}=android`,
                    `-P${props.keyAlias}=androiddebugkey`,
                    `-P${props.keyPassword}=android`
                ].join(' ');
                return await this.executeGradleTask(`assembleRelease ${signingArgs}`);
            }

            return await this.executeGradleTask('assembleRelease');
        });
    }

    /**
     * 检测 build.gradle 中 release signingConfig 引用的属性名。
     * 返回 { storeFile, storePassword, keyAlias, keyPassword } 各属性在项目中对应的 -P 参数名。
     * 未检测到时返回仅含 ANDROID_SIGNING_* 的回退映射。
     */
    private detectSigningPropertyNames(projectRoot: string): {
        storeFile: string;
        storePassword: string;
        keyAlias: string;
        keyPassword: string;
    } {
        const defaultMap = {
            storeFile: 'ANDROID_SIGNING_STORE_FILE',
            storePassword: 'ANDROID_SIGNING_STORE_PASSWORD',
            keyAlias: 'ANDROID_SIGNING_KEY_ALIAS',
            keyPassword: 'ANDROID_SIGNING_KEY_PASSWORD',
        };

        // 查找 app 模块的构建脚本
        const gradleFiles = [
            path.join(projectRoot, 'app', 'build.gradle.kts'),
            path.join(projectRoot, 'app', 'build.gradle'),
        ];

        let gradleContent: string | null = null;
        for (const file of gradleFiles) {
            if (fs.existsSync(file)) {
                gradleContent = fs.readFileSync(file, 'utf-8');
                break;
            }
        }

        if (!gradleContent) return defaultMap;

        // 提取 signingConfigs 块的内容
        const signingConfigMatch = gradleContent.match(
            /signingConfigs\s*\{[^}]*create\([\'"]release[\'"]\)\s*\{([\s\S]*?)\}\s*\}/i
        );

        if (!signingConfigMatch) {
            console.log('未在 build.gradle 中找到 release signingConfig');
            return defaultMap;
        }

        const block = signingConfigMatch[1];
        console.log('检测到 signingConfig 块, 解析属性引用...');

        // 尝试匹配 project.property("xxx") / project.findProperty("xxx") / project["xxx"]
        const propertyRefs: Record<string, string | null> = {
            storeFile: null,
            storePassword: null,
            keyAlias: null,
            keyPassword: null,
        };

        for (const key of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'] as const) {
            // 匹配 storeFile = file(project.property("XXX")) 或 storePassword = project.property("XXX")
            const regex = new RegExp(
                `${key}\\s*=\\s*(?:file\\(\\s*)?project\\.(?:findProperty|property)\\(\\s*[\'\"]([^\'\"]+)[\'\"]`
            );
            const match = block.match(regex);
            if (match?.[1]) {
                propertyRefs[key] = match[1];
                continue;
            }

            // 匹配 storeFile file(XXX) 或 storeFile = XXX (直接引用变量/属性)
            const directRegex = new RegExp(
                `${key}\\s*=\\s*(?:file\\(\\s*)?([A-Z_][A-Z0-9_]*)(?:\\s*\\))?`,
                'i'
            );
            const directMatch = block.match(directRegex);
            if (directMatch?.[1]) {
                // 排除关键字 (file, project, hasProperty 等)
                const val = directMatch[1];
                if (!['file', 'project', 'hasProperty', 'findProperty', 'property'].includes(val)) {
                    propertyRefs[key] = val;
                }
            }
        }

        return {
            storeFile: propertyRefs.storeFile || defaultMap.storeFile,
            storePassword: propertyRefs.storePassword || defaultMap.storePassword,
            keyAlias: propertyRefs.keyAlias || defaultMap.keyAlias,
            keyPassword: propertyRefs.keyPassword || defaultMap.keyPassword,
        };
    }

    /**
     * 构建已签名的 Release APK
     * 自动检测项目使用的 -P 属性名并注入
     */
    async buildReleaseSigned(
        keystorePath: string,
        keyAlias: string,
        storePassword: string,
        keyPassword: string
    ): Promise<string> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在构建已签名 Release APK...',
            cancellable: false
        }, async () => {
            const projectRoot = this.findProjectRoot();
            const props = this.detectSigningPropertyNames(projectRoot);

            const signingArgs = [
                `-P${props.storeFile}=${keystorePath}`,
                `-P${props.storePassword}=${storePassword}`,
                `-P${props.keyAlias}=${keyAlias}`,
                `-P${props.keyPassword}=${keyPassword}`
            ].join(' ');

            console.log(`使用签名属性: ${props.storeFile}, ${props.storePassword}, ${props.keyAlias}, ${props.keyPassword}`);

            return await this.executeGradleTask(`assembleRelease ${signingArgs}`);
        });
    }

    /**
     * 清理项目
     */
    async clean(): Promise<string> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在清理项目...',
            cancellable: false
        }, async () => {
            return await this.executeGradleTask('clean');
        });
    }

    /**
     * 同步 Gradle
     */
    async syncGradle(): Promise<void> {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在同步 Gradle...',
            cancellable: false
        }, async () => {
            try {
                await this.executeGradleTask('tasks', false);
                vscode.window.showInformationMessage('Gradle 同步完成！');
            } catch (error: any) {
                vscode.window.showErrorMessage(`Gradle 同步失败: ${error.message}`);
                throw error;
            }
        });
    }

    /**
     * 获取构建后的 APK 路径。
     * 递归搜索模块输出目录，支持构建变体（flavor）。
     */
    getApkPath(variant: 'debug' | 'release' = 'debug'): string {
        const projectRoot = this.findProjectRoot();

        let modulePath = 'app';
        if (this.targetModule) {
            modulePath = this.targetModule.replace(/^:/, '').replace(/:/g, path.sep);
        }

        const baseApkDir = path.join(
            projectRoot,
            modulePath,
            'build',
            'outputs',
            'apk'
        );

        this.outputChannel.appendLine(`正在 APK 目录搜索: ${baseApkDir}`);

        const defaultPath = path.join(baseApkDir, variant, `app-${variant}.apk`);

        try {
            if (fs.existsSync(baseApkDir)) {
                const findApks = (dir: string): string[] => {
                    let results: string[] = [];
                    const list = fs.readdirSync(dir);
                    list.forEach(file => {
                        const filePath = path.join(dir, file);
                        const stat = fs.statSync(filePath);
                        if (stat && stat.isDirectory()) {
                            results = results.concat(findApks(filePath));
                        } else if (file.endsWith('.apk')) {
                            results.push(filePath);
                        }
                    });
                    return results;
                };

                const allApks = findApks(baseApkDir);

                if (allApks.length > 0) {
                    const matches = allApks.filter(apk => {
                        const lowerPath = apk.toLowerCase();
                        const isAndroidTest = lowerPath.includes('androidtest');
                        const matchesVariant = lowerPath.includes(variant);
                        return matchesVariant && !isAndroidTest;
                    });

                    if (matches.length > 0) {
                        matches.sort((a, b) => {
                            return fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime();
                        });

                        const selected = matches[0];
                        this.outputChannel.appendLine(`找到 APK: ${selected}`);
                        return selected;
                    }
                }
            }
        } catch (error) {
            console.warn('Error scanning APK directory:', error);
        }

        return defaultPath;
    }

    /**
     * 检查当前工作区是否为 Android 项目
     */
    isAndroidProject(): boolean {
        try {
            const root = this.findProjectRoot();
            return isProjectRoot(root);
        } catch {
            return false;
        }
    }

    /**
     * 确保文件使用 Unix 换行符（LF），用于在 Windows 下运行 shell 脚本
     */
    private async ensureUnixLineEndings(filePath: string): Promise<void> {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            if (content.includes('\r\n')) {
                this.outputChannel.appendLine(`Fixing line endings for: ${path.basename(filePath)} (CRLF -> LF)`);
                const fixedContent = content.replace(/\r\n/g, '\n');
                fs.writeFileSync(filePath, fixedContent, 'utf8');
            }
        } catch (error) {
            console.warn(`Failed to fix line endings for ${filePath}:`, error);
        }
    }

    /**
     * 确保 local.properties 存在且包含正确的 sdk.dir
     */
    private async ensureLocalProperties(projectRoot: string): Promise<void> {
        const localPropsPath = path.join(projectRoot, 'local.properties');

        try {
            const sdkPath = this.sdkManager.getSDKPath();
            if (!sdkPath) {
                this.outputChannel.appendLine('Android SDK path not configured. Skipping local.properties check.');
                return;
            }

            const escapedSdkPath = sdkPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
            const sdkDirLine = `sdk.dir=${escapedSdkPath}`;

            if (fs.existsSync(localPropsPath)) {
                let content = fs.readFileSync(localPropsPath, 'utf8');
                if (!content.includes('sdk.dir')) {
                    this.outputChannel.appendLine('Update local.properties: Adding sdk.dir');
                    if (!content.endsWith('\n')) content += '\n';
                    content += `${sdkDirLine}\n`;
                    fs.writeFileSync(localPropsPath, content, 'utf8');
                }
            } else {
                this.outputChannel.appendLine('Creating local.properties with SDK path');
                const content = `## This file is automatically generated by Android Studio Flash\n# Do not check into Version Control Systems.\n${sdkDirLine}\n`;
                fs.writeFileSync(localPropsPath, content, 'utf8');
            }

        } catch (error: any) {
            this.outputChannel.appendLine(`Failed to update local.properties: ${error.message}`);
        }
    }

    dispose() {
        this.outputChannel.dispose();
    }
}
