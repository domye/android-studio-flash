import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * 证书信息，用于生成 keystore
 */
export interface CertificateInfo {
    alias: string;
    keyPassword: string;
    storePassword: string;
    validity: number; // 天数
    cn: string;  // 姓名
    ou: string;  // 部门
    o: string;   // 组织
    l: string;   // 城市
    st: string;  // 省份
    c: string;   // 国家代码（2 位）
}

/**
 * 保存在工作区中的 keystore 配置
 */
export interface KeystoreConfig {
    keystorePath: string;
    keyAlias: string;
}

/**
 * 管理 Android keystore 创建和签名操作。
 * 使用 JDK 的 keytool 生成 keystore。
 */
export class KeystoreManager {
    private readonly KEYSTORE_CONFIG_KEY = 'android.signing.keystore';
    private readonly STORE_PASSWORD_KEY = 'android.signing.storePassword';
    private readonly KEY_PASSWORD_KEY = 'android.signing.keyPassword';

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * 从 JAVA_HOME 或常见 JDK 位置查找 keytool
     */
    async getKeytoolPath(): Promise<string> {
        const isWindows = os.platform() === 'win32';
        const keytoolName = isWindows ? 'keytool.exe' : 'keytool';

        // 1. 尝试 JAVA_HOME
        const javaHome = process.env.JAVA_HOME;
        if (javaHome) {
            const keytoolPath = path.join(javaHome, 'bin', keytoolName);
            if (fs.existsSync(keytoolPath)) {
                return keytoolPath;
            }
        }

        // 2. 尝试从 PATH 查找
        try {
            const { stdout } = await execAsync(isWindows ? 'where keytool' : 'which keytool');
            const foundPath = stdout.trim().split('\n')[0];
            if (foundPath && fs.existsSync(foundPath)) {
                return foundPath;
            }
        } catch {
            // 不在 PATH 中
        }

        // 3. 常见 JDK 安装路径
        const commonPaths = this.getCommonJDKPaths();
        for (const jdkPath of commonPaths) {
            const keytoolPath = path.join(jdkPath, 'bin', keytoolName);
            if (fs.existsSync(keytoolPath)) {
                return keytoolPath;
            }
        }

        throw new Error(
            '未找到 keytool！\n\n' +
            '请确保已安装 JDK，并执行以下操作之一：\n' +
            '  - 设置 JAVA_HOME 环境变量\n' +
            '  - 将 JDK bin 目录添加到 PATH'
        );
    }

    /**
     * 获取常见 JDK 安装路径
     */
    private getCommonJDKPaths(): string[] {
        const platform = os.platform();
        const homeDir = os.homedir();

        if (platform === 'win32') {
            return [
                path.join(homeDir, 'AppData', 'Local', 'Android', 'Sdk', 'jbr'),
                'C:\\Program Files\\Java\\jdk-21',
                'C:\\Program Files\\Java\\jdk-17',
                'C:\\Program Files\\Java\\jdk-11',
                'C:\\Program Files\\Eclipse Adoptium\\jdk-21',
                'C:\\Program Files\\Eclipse Adoptium\\jdk-17',
                'C:\\Program Files\\Microsoft\\jdk-17',
            ];
        } else if (platform === 'darwin') {
            return [
                '/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home',
                '/Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home',
                path.join(homeDir, 'Library', 'Android', 'sdk', 'jbr'),
            ];
        } else {
            return [
                '/usr/lib/jvm/java-21-openjdk',
                '/usr/lib/jvm/java-17-openjdk',
                '/usr/lib/jvm/default-java',
            ];
        }
    }

    /**
     * 通过向导创建新的 keystore
     */
    async createKeystore(): Promise<string | null> {
        const saveUri = await vscode.window.showSaveDialog({
            title: '保存 Keystore 为',
            defaultUri: vscode.Uri.file(
                path.join(
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
                    'release-key.jks'
                )
            ),
            filters: {
                'Java 密钥库': ['jks', 'keystore'],
            }
        });

        if (!saveUri) {
            return null;
        }

        const keystorePath = saveUri.fsPath;

        const certInfo = await this.collectCertificateInfo();
        if (!certInfo) {
            return null;
        }

        try {
            await this.generateKeystore(keystorePath, certInfo);

            await this.saveKeystoreConfig({
                keystorePath,
                keyAlias: certInfo.alias
            });
            await this.savePasswords(certInfo.storePassword, certInfo.keyPassword);

            vscode.window.showInformationMessage(
                `Keystore 创建成功！\n\n` +
                `位置: ${keystorePath}\n` +
                `别名: ${certInfo.alias}\n\n` +
                `请妥善保管密码！密码已安全存储在 VS Code 中。`
            );

            return keystorePath;

        } catch (error: any) {
            vscode.window.showErrorMessage(`创建 keystore 失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 收集用户输入的证书信息
     */
    private async collectCertificateInfo(): Promise<CertificateInfo | null> {
        const alias = await vscode.window.showInputBox({
            title: '密钥别名 (1/8)',
            prompt: '为此密钥输入唯一名称',
            value: 'release-key',
            validateInput: v => v.trim() ? null : '必须填写别名'
        });
        if (!alias) return null;

        const storePassword = await vscode.window.showInputBox({
            title: 'Keystore 密码 (2/8)',
            prompt: '输入 keystore 密码（至少 6 个字符）',
            password: true,
            validateInput: v => v.length >= 6 ? null : '密码长度至少 6 个字符'
        });
        if (!storePassword) return null;

        const storePasswordConfirm = await vscode.window.showInputBox({
            title: '确认 Keystore 密码 (3/8)',
            prompt: '重新输入 keystore 密码',
            password: true,
            validateInput: v => v === storePassword ? null : '密码不匹配'
        });
        if (!storePasswordConfirm) return null;

        const usesSamePassword = await vscode.window.showQuickPick(
            [
                { label: '是', description: '密钥使用相同密码', value: true },
                { label: '否', description: '为密钥设置不同密码', value: false }
            ],
            { title: '密钥密码 (4/8)', placeHolder: '使用与 keystore 相同的密码？' }
        );
        if (!usesSamePassword) return null;

        let keyPassword = storePassword;
        if (!usesSamePassword.value) {
            const customKeyPassword = await vscode.window.showInputBox({
                title: '密钥密码',
                prompt: '输入密钥密码（至少 6 个字符）',
                password: true,
                validateInput: v => v.length >= 6 ? null : '密码长度至少 6 个字符'
            });
            if (!customKeyPassword) return null;
            keyPassword = customKeyPassword;
        }

        const cn = await vscode.window.showInputBox({
            title: '姓名 (5/8)',
            prompt: '输入你的姓名或组织名称',
            value: 'Developer',
            validateInput: v => v.trim() ? null : '必须填写姓名'
        });
        if (!cn) return null;

        const o = await vscode.window.showInputBox({
            title: '组织 (6/8)',
            prompt: '输入你的公司或组织名称（可选）',
            value: ''
        }) || '';

        const l = await vscode.window.showInputBox({
            title: '城市 (7/8)',
            prompt: '输入城市（可选）',
            value: ''
        }) || '';

        const c = await vscode.window.showInputBox({
            title: '国家代码 (8/8)',
            prompt: '输入两位字母国家代码（如 CN, US, JP）',
            value: '',
            validateInput: v => !v || /^[A-Za-z]{2}$/.test(v) ? null : '必须为 2 个字母'
        }) || '';

        return {
            alias,
            storePassword,
            keyPassword,
            validity: 10000,
            cn,
            ou: '',
            o,
            l,
            st: '',
            c
        };
    }

    /**
     * 使用 keytool 命令生成 keystore
     */
    private async generateKeystore(keystorePath: string, cert: CertificateInfo): Promise<void> {
        const keytool = await this.getKeytoolPath();

        const dnParts: string[] = [];
        if (cert.cn) dnParts.push(`CN=${cert.cn}`);
        if (cert.ou) dnParts.push(`OU=${cert.ou}`);
        if (cert.o) dnParts.push(`O=${cert.o}`);
        if (cert.l) dnParts.push(`L=${cert.l}`);
        if (cert.st) dnParts.push(`ST=${cert.st}`);
        if (cert.c) dnParts.push(`C=${cert.c}`);
        const dname = dnParts.join(', ');

        const command = [
            `"${keytool}"`,
            '-genkeypair',
            '-v',
            `-keystore "${keystorePath}"`,
            `-alias "${cert.alias}"`,
            `-keyalg RSA`,
            `-keysize 2048`,
            `-validity ${cert.validity}`,
            `-storepass "${cert.storePassword}"`,
            `-keypass "${cert.keyPassword}"`,
            `-dname "${dname}"`
        ].join(' ');

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在生成 keystore...',
            cancellable: false
        }, async () => {
            await execAsync(command);
        });
    }

    /**
     * 保存 keystore 配置到工作区状态
     */
    async saveKeystoreConfig(config: KeystoreConfig): Promise<void> {
        await this.context.workspaceState.update(this.KEYSTORE_CONFIG_KEY, config);
    }

    /**
     * 从工作区状态加载 keystore 配置
     */
    getKeystoreConfig(): KeystoreConfig | undefined {
        return this.context.workspaceState.get<KeystoreConfig>(this.KEYSTORE_CONFIG_KEY);
    }

    /**
     * 使用 VS Code SecretStorage 安全保存密码
     */
    async savePasswords(storePassword: string, keyPassword: string): Promise<void> {
        await this.context.secrets.store(this.STORE_PASSWORD_KEY, storePassword);
        await this.context.secrets.store(this.KEY_PASSWORD_KEY, keyPassword);
    }

    /**
     * 从 SecretStorage 获取密码
     */
    async getPasswords(): Promise<{ storePassword: string; keyPassword: string } | null> {
        const storePassword = await this.context.secrets.get(this.STORE_PASSWORD_KEY);
        const keyPassword = await this.context.secrets.get(this.KEY_PASSWORD_KEY);

        if (!storePassword || !keyPassword) {
            return null;
        }

        return { storePassword, keyPassword };
    }

    /**
     * 检查当前工作区是否已配置签名
     */
    isSigningConfigured(): boolean {
        const config = this.getKeystoreConfig();
        return !!config && fs.existsSync(config.keystorePath);
    }

    /**
     * 清除已保存的签名配置
     */
    async clearSigningConfig(): Promise<void> {
        await this.context.workspaceState.update(this.KEYSTORE_CONFIG_KEY, undefined);
        await this.context.secrets.delete(this.STORE_PASSWORD_KEY);
        await this.context.secrets.delete(this.KEY_PASSWORD_KEY);
    }

    /**
     * 选择已有的 keystore 文件
     */
    async selectExistingKeystore(): Promise<string | null> {
        const uri = await vscode.window.showOpenDialog({
            title: '选择 Keystore 文件',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'Java 密钥库': ['jks', 'keystore'],
                '所有文件': ['*']
            }
        });

        if (!uri || !uri[0]) {
            return null;
        }

        const keystorePath = uri[0].fsPath;

        const alias = await vscode.window.showInputBox({
            title: '密钥别名',
            prompt: '输入此 keystore 中使用的密钥别名',
            validateInput: v => v.trim() ? null : '必须填写别名'
        });

        if (!alias) {
            return null;
        }

        const storePassword = await vscode.window.showInputBox({
            title: 'Keystore 密码',
            prompt: '输入 keystore 密码',
            password: true,
            validateInput: v => v ? null : '必须填写密码'
        });

        if (!storePassword) {
            return null;
        }

        const keyPassword = await vscode.window.showInputBox({
            title: '密钥密码',
            prompt: '输入密钥密码（留空表示与 keystore 密码相同）',
            password: true
        });

        await this.saveKeystoreConfig({ keystorePath, keyAlias: alias });
        await this.savePasswords(storePassword, keyPassword || storePassword);

        vscode.window.showInformationMessage(`Keystore 已配置: ${path.basename(keystorePath)}`);

        return keystorePath;
    }
}
