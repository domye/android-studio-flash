import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GradleService } from '../core/GradleService';
import { DeviceManager } from '../devices/DeviceManager';
import { SigningWizard } from '../signing/SigningWizard';
import { BuildStatusBar } from '../ui/BuildStatusBar';

/**
 * Manages Android build operations including building, running, and debugging.
 */
export class BuildSystem {
    private signingWizard: SigningWizard | null = null;

    constructor(
        private gradleService: GradleService,
        private deviceManager: DeviceManager,
        private statusBar?: BuildStatusBar
    ) {}

    /**
     * Set the signing wizard (injected after construction)
     */
    setSigningWizard(wizard: SigningWizard): void {
        this.signingWizard = wizard;
    }

    /**
     * Build Debug APK
     */
    async buildDebug(): Promise<void> {
        this.statusBar?.showBuildStatus('Building Debug APK...');
        try {
            await this.gradleService.buildDebug();
            this.statusBar?.update();
            await this.handleBuildResult('debug');
        } catch (error: any) {
            this.statusBar?.update();
            vscode.window.showErrorMessage(`❌ Build failed: ${error.message}`);
        }
    }

    /**
     * Build Release APK with signing wizard
     */
    async buildRelease(): Promise<void> {
        this.statusBar?.showBuildStatus('Building Release APK...');
        try {
            if (this.signingWizard) {
                const result = await this.signingWizard.run();
                
                if (!result || !result.shouldProceed) {
                    vscode.window.showInformationMessage('❌ Build cancelled');
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
            vscode.window.showErrorMessage(`❌ Build failed: ${error.message}`);
        }
    }


    /**
     * Clean project
     */
    async cleanProject(): Promise<void> {
        try {
            await this.gradleService.clean();
            vscode.window.showInformationMessage('✅ Project cleaned successfully!');
        } catch (error: any) {
            vscode.window.showErrorMessage(`❌ Clean failed: ${error.message}`);
        }
    }

    /**
     * Run app on device
     */
    async runApp(): Promise<void> {
        this.statusBar?.showBuildStatus('Building & Running...');
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
            vscode.window.showErrorMessage(`❌ Run failed: ${error.message}`);
        }
    }

    /**
     * Handle post-build result: notify user, install or open folder.
     */
    private async handleBuildResult(variant: 'debug' | 'release'): Promise<void> {
        const apkPath = this.gradleService.getApkPath(variant);
        
        if (!fs.existsSync(apkPath)) {
            vscode.window.showWarningMessage('⚠️ APK file not found');
            return;
        }

        const action = await vscode.window.showInformationMessage(
            '✅ APK built successfully!',
            'Install on device',
            'Open folder'
        );

        if (action === 'Install on device') {
            await this.installAndRun(apkPath);
        } else if (action === 'Open folder') {
            vscode.env.openExternal(vscode.Uri.file(path.dirname(apkPath)));
        }
    }

    /**
     * Debug app on device
     */
    async debugApp(): Promise<void> {
        vscode.window.showInformationMessage('🚧 Debug feature is under development...');
        // TODO: Implement Debug Adapter Protocol
    }

    /**
     * Install and run APK on device
     */
    private async installAndRun(apkPath: string): Promise<void> {
        const selectedDevice = this.deviceManager.getSelectedDevice();
        
        if (!selectedDevice) {
            const devices = this.deviceManager.getDevices();
            if (devices.length === 0) {
                vscode.window.showWarningMessage('⚠️ No devices connected!');
                return;
            }
            await this.deviceManager.selectDevice();
            return this.installAndRun(apkPath);
        }

        try {
            // Install APK
            await this.deviceManager.installApk(apkPath);

            // Get package name
            const packageName = await this.deviceManager.getPackageName(apkPath);
            
            // Launch app
            const activityName = '.MainActivity'; // Default
            await this.deviceManager.launchApp(packageName, activityName);
            
            vscode.window.showInformationMessage('✅ App launched successfully!');

        } catch (error: any) {
            throw new Error(`Failed to install and run: ${error.message}`);
        }
    }
}
