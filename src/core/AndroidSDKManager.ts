import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * 管理 Android SDK 检测和路径解析。
 * 自动从设置、环境变量或默认路径检测 SDK 位置。
 */
export class AndroidSDKManager {
    private sdkPath: string = '';

    constructor() {
        this.detectSDK();
    }

    /**
     * 自动检测 Android SDK 路径
     */
    private detectSDK(): void {
        // 优先从设置读取
        const config = vscode.workspace.getConfiguration('android');
        const configuredPath = config.get<string>('sdkPath');

        if (configuredPath && fs.existsSync(configuredPath)) {
            this.sdkPath = configuredPath;
            console.log('SDK found from settings:', this.sdkPath);
            return;
        }

        // 从环境变量读取
        const envPath = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
        if (envPath && fs.existsSync(envPath)) {
            this.sdkPath = envPath;
            console.log('SDK found from environment:', this.sdkPath);
            return;
        }

        // 根据操作系统尝试默认路径
        const defaultPaths = this.getDefaultSDKPaths();
        for (const defaultPath of defaultPaths) {
            if (fs.existsSync(defaultPath)) {
                this.sdkPath = defaultPath;
                console.log('SDK found at default location:', this.sdkPath);
                return;
            }
        }

        console.warn('Android SDK not found automatically');
    }

    /**
     * 根据操作系统获取默认 SDK 路径列表
     */
    private getDefaultSDKPaths(): string[] {
        const homeDir = os.homedir();
        const platform = os.platform();

        if (platform === 'win32') {
            return [
                path.join(homeDir, 'AppData', 'Local', 'Android', 'Sdk'),
                'C:\\Android\\sdk',
                'C:\\Program Files\\Android\\Sdk',
                'C:\\Program Files (x86)\\Android\\Sdk'
            ];
        } else if (platform === 'darwin') {
            return [
                path.join(homeDir, 'Library', 'Android', 'sdk')
            ];
        } else {
            return [
                path.join(homeDir, 'Android', 'Sdk'),
                '/usr/local/android-sdk'
            ];
        }
    }

    /**
     * 获取 SDK 路径
     */
    getSDKPath(): string {
        return this.sdkPath;
    }

    /**
     * 获取 ADB 可执行文件路径
     */
    getADBPath(): string {
        if (!this.sdkPath) {
            throw new Error('Android SDK not found');
        }

        const adbName = os.platform() === 'win32' ? 'adb.exe' : 'adb';
        const adbPath = path.join(this.sdkPath, 'platform-tools', adbName);

        if (!fs.existsSync(adbPath)) {
            throw new Error('ADB not found at: ' + adbPath);
        }

        return adbPath;
    }

    /**
     * 获取 AVD Manager 路径
     */
    getAVDManagerPath(): string {
        if (!this.sdkPath) {
            throw new Error('Android SDK not found');
        }

        const scriptExt = os.platform() === 'win32' ? '.bat' : '';
        const avdManagerPath = path.join(this.sdkPath, 'cmdline-tools', 'latest', 'bin', `avdmanager${scriptExt}`);

        return avdManagerPath;
    }

    /**
     * 获取模拟器可执行文件路径
     */
    getEmulatorPath(): string {
        if (!this.sdkPath) {
            throw new Error('Android SDK not found');
        }

        const emulatorName = os.platform() === 'win32' ? 'emulator.exe' : 'emulator';
        const emulatorPath = path.join(this.sdkPath, 'emulator', emulatorName);

        return emulatorPath;
    }

    /**
     * 验证 SDK 是否已正确安装
     */
    async verifySDK(): Promise<boolean> {
        if (!this.sdkPath) {
            vscode.window.showErrorMessage('未找到 Android SDK。请在设置中配置路径。');
            return false;
        }

        try {
            this.getADBPath(); // 若未找到则会抛出异常
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`${error}`);
            return false;
        }
    }

    /**
     * 让用户选择 SDK 路径
     */
    async promptForSDKPath(): Promise<void> {
        const uri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: '选择 Android SDK 文件夹'
        });

        if (uri && uri[0]) {
            const selectedPath = uri[0].fsPath;
            const config = vscode.workspace.getConfiguration('android');
            await config.update('sdkPath', selectedPath, vscode.ConfigurationTarget.Global);
            this.sdkPath = selectedPath;
            vscode.window.showInformationMessage('SDK 路径更新成功！');
        }
    }
}
