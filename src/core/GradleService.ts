import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

import { AndroidSDKManager } from './AndroidSDKManager';

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
     * 在当前工作区和直接子目录中搜索 settings.gradle 或 build.gradle。
     */
    public findProjectRoot(): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder found');
        }

        const rootPath = workspaceFolder.uri.fsPath;

        // 1. 检查工作区根目录是否是项目根
        if (this.isProjectRoot(rootPath)) {
            return rootPath;
        }

        // 2. 检查直接子目录
        try {
            const subdirs = fs.readdirSync(rootPath)
                .map(name => path.join(rootPath, name))
                .filter(dir => fs.statSync(dir).isDirectory());

            for (const dir of subdirs) {
                if (this.isProjectRoot(dir)) {
                    return dir;
                }
            }
        } catch (error) {
            console.warn('Error scanning subdirectories:', error);
        }

        // 若未找到则默认使用工作区根
        return rootPath;
    }

    /**
     * 判断目录是否为 Gradle 项目根
     */
    private isProjectRoot(dirPath: string): boolean {
        const hasSettings = fs.existsSync(path.join(dirPath, 'settings.gradle')) ||
                           fs.existsSync(path.join(dirPath, 'settings.gradle.kts'));

        const hasBuild = fs.existsSync(path.join(dirPath, 'build.gradle')) ||
                        fs.existsSync(path.join(dirPath, 'build.gradle.kts'));

        const hasWrapper = fs.existsSync(path.join(dirPath, 'gradlew')) ||
                          fs.existsSync(path.join(dirPath, 'gradlew.bat'));

        return (hasSettings || hasBuild) && hasWrapper;
    }

    /**
     * 获取 Gradle Wrapper 路径
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
                return wrapperShell;
            }
        }

        throw new Error(`Gradle wrapper not found in ${projectRoot}. Make sure you are in an Android project directory.`);
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
    async executeGradleTask(task: string, showOutput: boolean = true): Promise<string> {
        try {
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

            let command = `"${gradlew}" ${finalTask}`;

            // Windows 兼容性：若只有 shell 脚本则通过 Java 直接运行
            if (os.platform() === 'win32' && !gradlew.endsWith('.bat')) {
                const jarPath = path.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
                if (fs.existsSync(jarPath)) {
                    command = `java -Dorg.gradle.appname=gradlew -cp "${jarPath}" org.gradle.wrapper.GradleWrapperMain ${finalTask}`;
                    this.outputChannel.appendLine('通过 Java 运行 Gradle（Windows 兼容模式）');
                } else {
                    await this.ensureUnixLineEndings(gradlew);
                    command = `bash "./gradlew" ${finalTask}`;
                }
            }

            const { stdout, stderr } = await execAsync(command, {
                cwd: projectRoot,
                maxBuffer: 10 * 1024 * 1024,
                env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME }
            });

            if (showOutput) {
                if (stdout) {
                    this.outputChannel.appendLine(stdout);
                }
                if (stderr) {
                    this.outputChannel.appendLine('警告:');
                    this.outputChannel.appendLine(stderr);
                }
                this.outputChannel.appendLine('='.repeat(50));
                this.outputChannel.appendLine('任务已完成！');
            }

            return stdout;

        } catch (error: any) {
            this.outputChannel.appendLine('='.repeat(50));
            this.outputChannel.appendLine('任务失败！');
            this.outputChannel.appendLine(error.message);
            if (error.stdout) {
                this.outputChannel.appendLine(error.stdout);
            }
            if (error.stderr) {
                this.outputChannel.appendLine(error.stderr);
            }
            throw error;
        }
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
     * 构建 Release APK
     */
    async buildRelease(): Promise<string> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在构建 Release APK...',
            cancellable: false
        }, async () => {
            return await this.executeGradleTask('assembleRelease');
        });
    }

    /**
     * 构建已签名的 Release APK
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
            const signingArgs = [
                `"-PANDROID_SIGNING_STORE_FILE=${keystorePath}"`,
                `"-PANDROID_SIGNING_KEY_ALIAS=${keyAlias}"`,
                `"-PANDROID_SIGNING_STORE_PASSWORD=${storePassword}"`,
                `"-PANDROID_SIGNING_KEY_PASSWORD=${keyPassword}"`
            ].join(' ');

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
            const projectRoot = this.findProjectRoot();
            return this.isProjectRoot(projectRoot);
        } catch (error) {
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
