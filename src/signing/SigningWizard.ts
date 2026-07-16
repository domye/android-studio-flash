import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { KeystoreManager, KeystoreConfig } from './KeystoreManager';

/**
 * 签名向导的返回结果
 */
export interface SigningResult {
    shouldProceed: boolean;
    signingMode: 'signed' | 'unsigned';
    keystoreConfig?: KeystoreConfig;
    storePassword?: string;
    keyPassword?: string;
}

/**
 * 智能签名向导，引导用户完成 release 签名流程。
 * 检查是否已配置签名，并据此提供选项。
 */
export class SigningWizard {
    constructor(private keystoreManager: KeystoreManager) {}

    /**
     * 运行签名向导
     * 返回签名配置或 null（取消）
     */
    async run(): Promise<SigningResult | null> {
        if (this.keystoreManager.isSigningConfigured()) {
            return await this.handleExistingConfig();
        }

        const hasGradleSigning = await this.checkGradleSigningConfig();
        if (hasGradleSigning) {
            return {
                shouldProceed: true,
                signingMode: 'signed'
            };
        }

        return await this.showSigningOptions();
    }

    /**
     * 处理已存在的签名配置
     */
    private async handleExistingConfig(): Promise<SigningResult | null> {
        const config = this.keystoreManager.getKeystoreConfig()!;
        const passwords = await this.keystoreManager.getPasswords();

        if (!passwords) {
            const storePassword = await vscode.window.showInputBox({
                title: 'Keystore Password',
                prompt: `输入 ${path.basename(config.keystorePath)} 的密码`,
                password: true
            });

            if (!storePassword) return null;

            const keyPassword = await vscode.window.showInputBox({
                title: 'Key Password',
                prompt: '输入密钥密码（留空表示相同）',
                password: true
            });

            await this.keystoreManager.savePasswords(storePassword, keyPassword || storePassword);

            return {
                shouldProceed: true,
                signingMode: 'signed',
                keystoreConfig: config,
                storePassword,
                keyPassword: keyPassword || storePassword
            };
        }

        const action = await vscode.window.showQuickPick([
            {
                label: '使用已保存的签名配置',
                description: path.basename(config.keystorePath),
                value: 'use' as const
            },
            {
                label: '更换签名配置',
                description: '选择其他 keystore',
                value: 'change' as const
            },
            {
                label: '构建未签名的 APK',
                description: '不签名进行构建',
                value: 'unsigned' as const
            }
        ], {
            title: 'Release 签名',
            placeHolder: '请选择如何签名 release APK？'
        });

        if (!action) return null;

        switch (action.value) {
            case 'use':
                return {
                    shouldProceed: true,
                    signingMode: 'signed',
                    keystoreConfig: config,
                    storePassword: passwords.storePassword,
                    keyPassword: passwords.keyPassword
                };

            case 'change':
                await this.keystoreManager.clearSigningConfig();
                return await this.showSigningOptions();

            case 'unsigned':
                return {
                    shouldProceed: true,
                    signingMode: 'unsigned'
                };
        }

        return null;
    }

    /**
     * 查找 Android 项目根目录（与 GradleService.findProjectRoot 对应）
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
     * 检查 build.gradle 是否已包含签名配置
     */
    private async checkGradleSigningConfig(): Promise<boolean> {
        const projectRoot = this.findProjectRoot();
        if (!projectRoot) return false;

        const gradleFiles = [
            path.join(projectRoot, 'app', 'build.gradle'),
            path.join(projectRoot, 'app', 'build.gradle.kts')
        ];

        for (const gradleFile of gradleFiles) {
            if (fs.existsSync(gradleFile)) {
                try {
                    const content = fs.readFileSync(gradleFile, 'utf-8');

                    if (content.includes('signingConfigs') &&
                        (content.includes('signingConfig') || content.includes('release {'))) {

                        if (content.includes('storeFile')) {
                            console.log('Found signing config in build.gradle');
                            return true;
                        }
                    }
                } catch (error) {
                    console.error('Error reading build.gradle:', error);
                }
            }
        }

        return false;
    }

    /**
     * 显示签名选项（无已有配置时）
     */
    private async showSigningOptions(): Promise<SigningResult | null> {
        const choice = await vscode.window.showQuickPick([
            {
                label: '创建新的 Keystore',
                description: '生成新的签名密钥（推荐新应用使用）',
                value: 'create' as const
            },
            {
                label: '使用已有的 Keystore',
                description: '选择已有的 keystore 文件',
                value: 'existing' as const
            },
            {
                label: '构建未签名的 APK',
                description: '跳过签名（大多数设备无法安装）',
                value: 'unsigned' as const
            }
        ], {
            title: '需要 Release 签名',
            placeHolder: 'Release APK 必须签名。请选择：'
        });

        if (!choice) return null;

        switch (choice.value) {
            case 'create':
                const created = await this.keystoreManager.createKeystore();
                if (!created) return null;

                const passwords = await this.keystoreManager.getPasswords();
                const config = this.keystoreManager.getKeystoreConfig();

                return {
                    shouldProceed: true,
                    signingMode: 'signed',
                    keystoreConfig: config,
                    storePassword: passwords?.storePassword,
                    keyPassword: passwords?.keyPassword
                };

            case 'existing':
                const selected = await this.keystoreManager.selectExistingKeystore();
                if (!selected) return null;

                const existingPasswords = await this.keystoreManager.getPasswords();
                const existingConfig = this.keystoreManager.getKeystoreConfig();

                return {
                    shouldProceed: true,
                    signingMode: 'signed',
                    keystoreConfig: existingConfig,
                    storePassword: existingPasswords?.storePassword,
                    keyPassword: existingPasswords?.keyPassword
                };

            case 'unsigned':
                const confirm = await vscode.window.showWarningMessage(
                    '未签名的 APK 在大多数设备上无法安装，也无法上传到 Play Store。',
                    { modal: true },
                    '仍然构建',
                    '取消'
                );

                if (confirm !== '仍然构建') return null;

                return {
                    shouldProceed: true,
                    signingMode: 'unsigned'
                };
        }

        return null;
    }
}
