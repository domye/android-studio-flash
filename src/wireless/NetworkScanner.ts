import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

/**
 * 网络扫描中发现的设备
 */
export interface ScannedDevice {
    ip: string;
    port: number;
    name?: string;
}

/**
 * 扫描本地网络中启用了 ADB 的 Android 设备。
 */
export class NetworkScanner {
    constructor(private adbPath: string) {}

    /**
     * 扫描本地网络中的 Android 设备
     */
    async scanNetwork(): Promise<ScannedDevice[]> {
        const localIp = this.getLocalIp();
        if (!localIp) {
            vscode.window.showErrorMessage('无法确定本地 IP 地址');
            return [];
        }

        const subnet = localIp.substring(0, localIp.lastIndexOf('.'));

        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在扫描网络...',
            cancellable: true
        }, async (progress, token) => {
            const devices: ScannedDevice[] = [];
            const port = 5555;

            const ipsToTest: string[] = [];

            // 优先测试常见地址段
            for (let i = 1; i <= 20; i++) {
                ipsToTest.push(`${subnet}.${i}`);
            }
            for (let i = 100; i <= 120; i++) {
                ipsToTest.push(`${subnet}.${i}`);
            }
            for (let i = 200; i <= 220; i++) {
                ipsToTest.push(`${subnet}.${i}`);
            }

            let tested = 0;
            for (const ip of ipsToTest) {
                if (token.isCancellationRequested) {
                    break;
                }

                tested++;
                progress.report({
                    message: `正在检查 ${ip}... (${tested}/${ipsToTest.length})`,
                    increment: (100 / ipsToTest.length)
                });

                if (await this.testConnection(ip, port)) {
                    devices.push({ ip, port });
                }
            }

            return devices;
        });
    }

    /**
     * 获取本地 IP 地址
     */
    private getLocalIp(): string | null {
        const interfaces = os.networkInterfaces();

        for (const name of Object.keys(interfaces)) {
            const iface = interfaces[name];
            if (!iface) {
                continue;
            }

            for (const alias of iface) {
                if (alias.family === 'IPv4' && !alias.internal) {
                    return alias.address;
                }
            }
        }

        return null;
    }

    /**
     * 测试能否连接到 IP:Port
     */
    private async testConnection(ip: string, port: number): Promise<boolean> {
        try {
            const endpoint = `${ip}:${port}`;

            const { stdout } = await execAsync(
                `"${this.adbPath}" connect ${endpoint}`,
                { timeout: 1500 }
            );

            if (stdout.includes('connected')) {
                try {
                    await execAsync(`"${this.adbPath}" disconnect ${endpoint}`, { timeout: 500 });
                } catch (e) {
                    // 忽略断开连接时的错误
                }
                return true;
            }

            return false;

        } catch (error) {
            return false;
        }
    }
}
