import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GradleService } from '../core/GradleService';
import { DeviceManager } from '../devices/DeviceManager';
import { SigningWizard } from '../signing/SigningWizard';
import { BuildStatusBar } from '../ui/BuildStatusBar';

/**
 * 管理 Android 构建操作，包括构建、运行和调试。
 */
export class BuildSystem {
    private signingWizard: SigningWizard | null = null;

    constructor(
        private gradleService: GradleService,
        private deviceManager: DeviceManager,
        private statusBar?: BuildStatusBar
    ) {}

    /**
     * 设置签名向导（构造后注入）
     */
    setSigningWizard(wizard: SigningWizard): void {
        this.signingWizard = wizard;
    }

    /**
     * 构建 Debug APK
     */
    async buildDebug(): Promise<void> {
        this.statusBar?.showBuildStatus('构建 Debug APK...');
        try {
            await this.gradleService.buildDebug();
            this.statusBar?.update();
            await this.handleBuildResult('debug');
        } catch (error: any) {
            this.statusBar?.update();
            vscode.window.showErrorMessage(`构建失败: ${error.message}`);
        }
    }

    /**
     * 构建 Release APK（含签名向导）
     */
    async buildRelease(): Promise<void> {
        this.statusBar?.showBuildStatus('构建 Release APK...');
        try {
            if (this.signingWizard) {
                const result = await this.signingWizard.run();

                if (!result || !result.shouldProceed) {
                    vscode.window.showInformationMessage('构建已取消');
                    this.statusBar?.update();
                    return;
                }

                if (result.signingMode === 'signed' && result.keystoreConfig && result.storePassword) {
                    await this.gradleService.buildReleaseSigned(
                        result.keystoreConfig.keystorePath,
                        result.keystoreConfig.keyAlias,
                        result.storePassword,
                        result.keyPassword || result.storePassword
                    );
                } else {
                    await this.gradleService.buildRelease();
                }
            } else {
                await this.gradleService.buildRelease();
            }

            this.statusBar?.update();
            await this.handleBuildResult('release');
        } catch (error: any) {
            this.statusBar?.update();
            vscode.window.showErrorMessage(`构建失败: ${error.message}`);
        }
    }


    /**
     * 清理项目
     */
    async cleanProject(): Promise<void> {
        try {
            await this.gradleService.clean();
            vscode.window.showInformationMessage('项目清理成功！');
        } catch (error: any) {
            vscode.window.showErrorMessage(`清理失败: ${error.message}`);
        }
    }

    /**
     * 在设备上运行应用
     */
    async runApp(): Promise<void> {
        this.statusBar?.showBuildStatus('构建并运行...');
        try {
            await this.gradleService.buildDebug();

            const apkPath = this.gradleService.getApkPath('debug');

            if (!fs.existsSync(apkPath)) {
                this.statusBar?.update();
                throw new Error('APK file not found');
            }

            await this.installAndRun(apkPath);
            this.statusBar?.update();
        } catch (error: any) {
            this.statusBar?.update();
            vscode.window.showErrorMessage(`运行失败: ${error.message}`);
        }
    }

    /**
     * 处理构建后的结果：通知用户，安装或打开文件夹
     */
    private async handleBuildResult(variant: 'debug' | 'release'): Promise<void> {
        const apkPath = this.gradleService.getApkPath(variant);

        if (!fs.existsSync(apkPath)) {
            vscode.window.showWarningMessage('未找到 APK 文件');
            return;
        }

        const action = await vscode.window.showInformationMessage(
            'APK 构建成功！',
            '安装到设备',
            '打开文件夹'
        );

        if (action === '安装到设备') {
            await this.installAndRun(apkPath);
        } else if (action === '打开文件夹') {
            vscode.env.openExternal(vscode.Uri.file(path.dirname(apkPath)));
        }
    }

    /**
     * 调试应用（尚未实现）
     */
    async debugApp(): Promise<void> {
        vscode.window.showInformationMessage('调试功能正在开发中...');
    }

    /**
     * 在设备上安装并运行 APK
     */
    private async installAndRun(apkPath: string): Promise<void> {
        const selectedDevice = this.deviceManager.getSelectedDevice();

        if (!selectedDevice) {
            const devices = this.deviceManager.getDevices();
            if (devices.length === 0) {
                vscode.window.showWarningMessage('没有已连接的设备！');
                return;
            }
            await this.deviceManager.selectDevice();
            return this.installAndRun(apkPath);
        }

        try {
            await this.deviceManager.installApk(apkPath);

            const packageName = await this.deviceManager.getPackageName(apkPath);

            const activityName = '.MainActivity'; // 默认 Activity
            await this.deviceManager.launchApp(packageName, activityName);

            vscode.window.showInformationMessage('应用启动成功！');

        } catch (error: any) {
            throw new Error(`Failed to install and run: ${error.message}`);
        }
    }
}
