import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DeviceManager } from '../devices/DeviceManager';
import { AndroidSDKManager } from '../core/AndroidSDKManager';
import { PackageNameDetector } from '../utils/PackageNameDetector';

const execAsync = promisify(exec);

export type LogcatFilterMode = 'all' | 'app' | 'tag';

/**
 * 管理 Android Logcat 输出，支持过滤和格式化。
 */
export class LogcatManager {
    private outputChannel: vscode.LogOutputChannel;
    private logcatProcess: ChildProcess | null = null;
    private sdkManager: AndroidSDKManager;
    private isRunning: boolean = false;
    private currentFilterMode: LogcatFilterMode = 'app';
    private currentPackageName: string = '';
    private currentTag: string = '';
    private useGrepFilter: boolean = false;

    constructor(private deviceManager: DeviceManager, sdkManager?: AndroidSDKManager) {
        this.outputChannel = vscode.window.createOutputChannel('Android Logcat', { log: true });
        this.sdkManager = sdkManager || new AndroidSDKManager();
    }

    /**
     * 查找 Android 项目根目录
     */
    private findProjectRoot(): string | undefined {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return undefined;

        const rootPath = workspaceFolder.uri.fsPath;

        const isRoot = (dir: string): boolean => {
            const hasSettings = fs.existsSync(path.join(dir, 'settings.gradle')) ||
                               fs.existsSync(path.join(dir, 'settings.gradle.kts'));
            const hasBuild = fs.existsSync(path.join(dir, 'build.gradle')) ||
                            fs.existsSync(path.join(dir, 'build.gradle.kts'));
            const hasWrapper = fs.existsSync(path.join(dir, 'gradlew')) ||
                              fs.existsSync(path.join(dir, 'gradlew.bat'));
            return (hasSettings || hasBuild) && hasWrapper;
        };

        if (isRoot(rootPath)) return rootPath;

        try {
            const subdirs = fs.readdirSync(rootPath)
                .map(name => path.join(rootPath, name))
                .filter(dir => fs.statSync(dir).isDirectory());
            for (const dir of subdirs) {
                if (isRoot(dir)) return dir;
            }
        } catch { /* ignore */ }

        return rootPath;
    }

    /**
     * 显示 Logcat（可指定过滤模式）
     */
    async showLogcat(filterMode?: LogcatFilterMode, packageName?: string, tag?: string): Promise<void> {
        const selectedDevice = this.deviceManager.getSelectedDevice();

        if (!selectedDevice) {
            vscode.window.showWarningMessage('请先选择设备');
            return;
        }

        this.stopLogcat();

        if (filterMode) {
            this.currentFilterMode = filterMode;
        }

        if (packageName) {
            this.currentPackageName = packageName;
        }

        if (tag) {
            this.currentTag = tag;
        }

        // 若为 app 模式且无包名，自动检测
        if (this.currentFilterMode === 'app' && !this.currentPackageName) {
            const projectRoot = this.findProjectRoot();

            const detectionResults = await PackageNameDetector.detectPackageNameSmart(
                this.sdkManager.getADBPath(),
                selectedDevice.id,
                projectRoot
            );

            if (detectionResults.length === 0) {
                vscode.window.showWarningMessage('未找到包名。需要手动输入。');
                const input = await vscode.window.showInputBox({
                    prompt: '输入应用包名',
                    placeHolder: 'com.example.app'
                });

                if (!input) {
                    return;
                }

                this.currentPackageName = input;
            } else {
                const selectedPackage = await PackageNameDetector.promptForPackageName(detectionResults);

                if (!selectedPackage) {
                    return;
                }

                this.currentPackageName = selectedPackage;

                const selected = detectionResults.find(r => r.packageName === selectedPackage);
                if (selected) {
                    const sourceNames = {
                        apk: 'Built APK',
                        foreground: 'Foreground App',
                        gradle: 'build.gradle',
                        manifest: 'AndroidManifest.xml',
                        device: 'Device'
                    };
                    console.log(`Using package: ${selectedPackage} (from ${sourceNames[selected.source]})`);
                }
            }
        }

        // 若为 tag 模式且无标签，询问用户
        if (this.currentFilterMode === 'tag' && !this.currentTag) {
            const input = await vscode.window.showInputBox({
                prompt: '输入要过滤的 TAG',
                placeHolder: 'MyApp'
            });

            if (!input) {
                return;
            }

            this.currentTag = input;
        }

        this.outputChannel.show(true);

        try {
            const adbPath = this.sdkManager.getADBPath();

            this.outputChannel.clear();
            this.outputChannel.appendLine('='.repeat(80));
            this.outputChannel.appendLine(`设备: ${selectedDevice.model || selectedDevice.id}`);
            this.outputChannel.appendLine(`过滤模式: ${this.getFilterModeLabel()}`);
            this.outputChannel.appendLine('='.repeat(80));

            this.useGrepFilter = false;
            const logcatArgs = await this.buildLogcatArgs(selectedDevice.id);

            this.logcatProcess = spawn(adbPath, logcatArgs);
            this.isRunning = true;

            this.logcatProcess.stdout?.on('data', (data: Buffer) => {
                const lines = data.toString().split('\n');
                lines.forEach(line => {
                    if (line.trim()) {
                        if (this.useGrepFilter && this.currentPackageName) {
                            if (line.includes(this.currentPackageName)) {
                                this.logFormattedLine(line);
                            }
                        } else {
                            this.logFormattedLine(line);
                        }
                    }
                });
            });

            this.logcatProcess.on('close', () => {
                this.isRunning = false;
                this.outputChannel.appendLine('='.repeat(80));
                this.outputChannel.appendLine('Logcat 已结束');
            });

        } catch (error: any) {
            vscode.window.showErrorMessage(`启动 Logcat 失败: ${error.message}`);
        }
    }

    /**
     * 根据过滤模式构建 logcat 参数
     */
    private async buildLogcatArgs(deviceId: string): Promise<string[]> {
        const args = ['-s', deviceId, 'logcat', '-v', 'time'];

        switch (this.currentFilterMode) {
            case 'app':
                if (this.currentPackageName) {
                    try {
                        const adbPath = this.sdkManager.getADBPath();

                        const { stdout } = await execAsync(
                            `"${adbPath}" -s ${deviceId} shell "pidof -s ${this.currentPackageName}"`
                        );

                        const pid = stdout.trim();

                        if (pid && pid !== '') {
                            console.log(`Found PID for ${this.currentPackageName}: ${pid}`);
                            args.push('--pid', pid);
                        } else {
                            console.log(`App ${this.currentPackageName} is not running. Using grep filter instead.`);
                            this.useGrepFilter = true;
                        }
                    } catch (error) {
                        console.log(`Could not get PID. App may not be running.`);
                        this.useGrepFilter = true;
                    }
                }
                break;

            case 'tag':
                if (this.currentTag) {
                    args.push('-s');
                    args.push(`${this.currentTag}:*`);
                }
                break;

            case 'all':
            default:
                break;
        }

        return args;
    }

    /**
     * 获取过滤模式标签
     */
    private getFilterModeLabel(): string {
        switch (this.currentFilterMode) {
            case 'all':
                return '所有日志';
            case 'app':
                return `仅应用: ${this.currentPackageName}`;
            case 'tag':
                return `TAG 过滤: ${this.currentTag}`;
            default:
                return '未知';
        }
    }

    /**
     * 切换过滤模式
     */
    async toggleFilterMode(): Promise<void> {
        const modes: { label: string; mode: LogcatFilterMode; description: string }[] = [
            {
                label: '仅应用',
                mode: 'app',
                description: '仅显示应用日志（类似 Android Studio）'
            },
            {
                label: '所有日志',
                mode: 'all',
                description: '显示设备所有日志'
            },
            {
                label: '按 TAG 过滤',
                mode: 'tag',
                description: '按指定 TAG 过滤'
            }
        ];

        const selected = await vscode.window.showQuickPick(modes, {
            placeHolder: '选择过滤模式'
        });

        if (selected) {
            this.currentFilterMode = selected.mode;

            if (this.isRunning) {
                await this.showLogcat();
            } else {
                vscode.window.showInformationMessage(`过滤模式已切换为: ${selected.label}`);
            }
        }
    }

    /**
     * 根据日志级别格式化输出
     */
    private logFormattedLine(line: string): void {
        const formattedLine = this.formatLogLine(line);

        if (line.includes(' E/') || line.includes('ERROR')) {
            this.outputChannel.error(formattedLine);
        } else if (line.includes(' W/') || line.includes('WARNING')) {
            this.outputChannel.warn(formattedLine);
        } else if (line.includes(' I/') || line.includes('INFO')) {
            this.outputChannel.info(formattedLine);
        } else {
            this.outputChannel.trace(formattedLine);
        }
    }

    /**
     * 格式化日志行，添加级别标识
     */
    private formatLogLine(line: string): string {
        const logLevelMatch = line.match(/(\d{2}-\d{2}\s+)?(\d{2}:\d{2}:\d{2}\.\d+)\s+([VDIWEF])\/([^(]+)\((\d+)\):\s+(.+)/);

        if (logLevelMatch) {
            const [, , time, level, tag, pid, message] = logLevelMatch;

            const shortTime = time.substring(0, 12);

            let levelName = '';

            switch (level) {
                case 'E':
                    levelName = 'ERROR';
                    break;
                case 'W':
                    levelName = 'WARN';
                    break;
                case 'I':
                    levelName = 'INFO';
                    break;
                case 'D':
                    levelName = 'DEBUG';
                    break;
                case 'V':
                    levelName = 'VERB';
                    break;
                case 'F':
                    levelName = 'FATAL';
                    break;
                default:
                    return line;
            }

            const isStackTrace = message.trim().startsWith('at ') ||
                                message.includes('Exception') ||
                                message.includes('Error:');

            const prefix = isStackTrace ? '  -> ' : '';

            return [
                shortTime,
                levelName.padEnd(5),
                '|',
                tag.trim().padEnd(25),
                '|',
                `(${pid.padStart(5)})`,
                '|',
                prefix + message
            ].join(' ');
        }

        return line;
    }

    /**
     * 清空 Logcat 输出
     */
    clearLogcat(): void {
        this.outputChannel.clear();
        this.outputChannel.appendLine('Logcat 已清空');

        const selectedDevice = this.deviceManager.getSelectedDevice();
        if (selectedDevice && this.isRunning) {
            this.outputChannel.appendLine('='.repeat(80));
            this.outputChannel.appendLine(`设备: ${selectedDevice.model || selectedDevice.id}`);
            this.outputChannel.appendLine(`过滤模式: ${this.getFilterModeLabel()}`);
            this.outputChannel.appendLine('='.repeat(80));
        }
    }

    /**
     * 停止 Logcat
     */
    stopLogcat(): void {
        if (this.logcatProcess) {
            this.logcatProcess.kill();
            this.logcatProcess = null;
            this.isRunning = false;
        }
    }

    /**
     * 获取当前过滤模式
     */
    getCurrentFilterMode(): LogcatFilterMode {
        return this.currentFilterMode;
    }

    dispose() {
        this.stopLogcat();
        this.outputChannel.dispose();
    }
}
