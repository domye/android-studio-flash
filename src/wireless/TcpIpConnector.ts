import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { NetworkScanner, ScannedDevice } from './NetworkScanner';

const execAsync = promisify(exec);

/**
 * 处理 ADB over TCP/IP 连接，支持 Android 4.0+。
 * 需要先通过 USB 连接以启用 TCP/IP 模式。
 */
export class TcpIpConnector {
    private scanner: NetworkScanner;

    constructor(private adbPath: string) {
        this.scanner = new NetworkScanner(adbPath);
    }

    /**
     * 设置 ADB over TCP/IP 连接
     */
    async setupConnection(): Promise<void> {
        const method = await vscode.window.showQuickPick([
            {
                label: '设备已通过 USB 连接',
                description: '当前已使用 USB 线连接设备',
                value: 'usb' as const
            },
            {
                label: '设备在网络中',
                description: '设备之前已配置过',
                value: 'network' as const
            }
        ], {
            placeHolder: '设备当前状态？'
        });

        if (!method) {
            return;
        }

        if (method.value === 'usb') {
            await this.setupFromUsb();
        } else {
            await this.connectToExistingDevice();
        }
    }

    /**
     * 通过 USB 连接的设备进行设置
     */
    private async setupFromUsb(): Promise<void> {
        try {
            const { stdout } = await execAsync(`"${this.adbPath}" devices`);
            const usbDevices = this.parseUsbDevices(stdout);

            if (usbDevices.length === 0) {
                vscode.window.showWarningMessage('没有通过 USB 连接的设备');
                return;
            }

            let selectedDeviceId: string;

            if (usbDevices.length === 1) {
                selectedDeviceId = usbDevices[0];
            } else {
                const selected = await vscode.window.showQuickPick(
                    usbDevices.map(id => ({ label: id, value: id })),
                    { placeHolder: '选择设备' }
                );
                if (!selected) {
                    return;
                }
                selectedDeviceId = selected.value;
            }

            await this.enableTcpIpMode(selectedDeviceId);

        } catch (error: any) {
            vscode.window.showErrorMessage(`错误: ${error.message}`);
        }
    }

    /**
     * 从 adb 输出中解析 USB 设备
     */
    private parseUsbDevices(adbOutput: string): string[] {
        const lines = adbOutput.split('\n');
        const devices: string[] = [];

        for (const line of lines) {
            if (line && !line.startsWith('List of devices') && line.trim()) {
                const parts = line.split(/\s+/);
                if (parts.length >= 2 && parts[1] === 'device') {
                    if (!parts[0].includes(':')) {
                        devices.push(parts[0]);
                    }
                }
            }
        }

        return devices;
    }

    /**
     * 在设备上启用 TCP/IP 模式
     */
    private async enableTcpIpMode(deviceId: string, port: number = 5555): Promise<void> {
        try {
            // 在启用 TCP/IP 之前获取 IP（设备会断开 USB！）
            const deviceIp = await this.getDeviceIp(deviceId);

            if (!deviceIp) {
                vscode.window.showWarningMessage(
                    '无法获取设备 IP。\n' +
                    '请确保设备已连接到 WiFi 后重试。'
                );
                await this.connectToExistingDevice(port);
                return;
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '正在启用 TCP/IP 模式...',
                cancellable: false
            }, async () => {
                await execAsync(`"${this.adbPath}" -s ${deviceId} tcpip ${port}`);
            });

            await this.sleep(1500);

            const endpoint = `${deviceIp}:${port}`;

            const action = await vscode.window.showInformationMessage(
                `TCP/IP 模式已成功启用！\n\n` +
                `设备: ${deviceId}\n` +
                `连接地址: ${endpoint}\n\n` +
                `现在可以断开 USB 数据线，通过无线连接。`,
                {
                    modal: true,
                    detail: '确认后将自动建立连接。'
                },
                '立即连接',
                '复制 IP',
                '取消'
            );

            if (action === '复制 IP') {
                await vscode.env.clipboard.writeText(endpoint);
                vscode.window.showInformationMessage(`已复制: ${endpoint}`);

                const retryAction = await vscode.window.showInformationMessage(
                    `IP 已复制: ${endpoint}\n\n是否立即连接？`,
                    '立即连接',
                    '取消'
                );

                if (retryAction === '立即连接') {
                    await this.connectToDevice(deviceIp, port);
                }
            } else if (action === '立即连接') {
                await this.connectToDevice(deviceIp, port);
            }

        } catch (error: any) {
            vscode.window.showErrorMessage(`启用 TCP/IP 失败: ${error.message}`);
        }
    }

    /**
     * 获取设备 IP 地址（在 USB 连接时）。
     * 搜索多个网络接口以支持各种连接模式：
     * - wlan0：标准 WiFi
     * - ap0/swlan0/wlan1：热点模式
     * - rndis0：USB 网络共享
     */
    private async getDeviceIp(deviceId: string): Promise<string | null> {
        try {
            const { stdout } = await execAsync(
                `"${this.adbPath}" -s ${deviceId} shell ip addr`,
                { timeout: 5000 }
            );

            const privateIpPatterns = [
                /inet\s+(192\.168\.\d+\.\d+)/,
                /inet\s+(10\.\d+\.\d+\.\d+)/,
                /inet\s+(172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)/
            ];

            for (const pattern of privateIpPatterns) {
                const match = stdout.match(pattern);
                if (match && match[1]) {
                    console.log(`Got device IP: ${match[1]}`);
                    return match[1];
                }
            }

            console.warn('No private IP found in any network interface');
            return null;

        } catch (error: any) {
            console.error('Failed to get device IP:', error.message);
            return null;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 连接到网络中的已有设备
     */
    private async connectToExistingDevice(defaultPort: number = 5555): Promise<void> {
        const method = await vscode.window.showQuickPick([
            {
                label: '手动输入 IP',
                value: 'manual' as const
            },
            {
                label: '扫描网络',
                description: '自动搜索设备（可能需要一些时间）',
                value: 'scan' as const
            }
        ], {
            placeHolder: '如何查找设备？'
        });

        if (!method) {
            return;
        }

        if (method.value === 'manual') {
            await this.connectManually(defaultPort);
        } else {
            await this.scanAndConnect();
        }
    }

    /**
     * 手动输入 IP 连接
     */
    private async connectManually(defaultPort: number): Promise<void> {
        const ipAddress = await vscode.window.showInputBox({
            prompt: '输入设备 IP 地址（在 设置 -> 关于 -> 状态 中查看）',
            placeHolder: '192.168.1.100',
            validateInput: (value) => {
                const regex = /^(\d{1,3}\.){3}\d{1,3}$/;
                return regex.test(value) ? null : 'IP 格式错误';
            }
        });

        if (!ipAddress) {
            return;
        }

        await this.connectToDevice(ipAddress, defaultPort);
    }

    /**
     * 扫描网络并连接
     */
    private async scanAndConnect(): Promise<void> {
        const foundDevices = await this.scanner.scanNetwork();

        if (foundDevices.length === 0) {
            vscode.window.showWarningMessage('没有找到设备');
            return;
        }

        const selected = await vscode.window.showQuickPick(
            foundDevices.map((device: ScannedDevice) => ({
                label: device.name || device.ip,
                description: device.ip,
                deviceInfo: device
            })),
            { placeHolder: '选择设备' }
        );

        if (!selected) {
            return;
        }

        await this.connectToDevice(selected.deviceInfo.ip, selected.deviceInfo.port);
    }

    /**
     * 连接到设备
     */
    private async connectToDevice(ip: string, port: number): Promise<void> {
        const endpoint = `${ip}:${port}`;

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `正在连接 ${endpoint}...`,
                cancellable: false
            }, async () => {
                await execAsync(`"${this.adbPath}" connect ${endpoint}`);
            });

            vscode.window.showInformationMessage(
                `连接成功！\n${endpoint}\n\n` +
                '现在可以断开 USB 数据线'
            );

            vscode.commands.executeCommand('android.refreshDevices');

        } catch (error: any) {
            vscode.window.showErrorMessage(
                `连接到 ${endpoint} 失败: ${error.message}\n\n` +
                '请确保：\n' +
                '  - 设备和电脑在同一个网络中\n' +
                '  - IP 地址正确\n' +
                '  - 设备已开启开发者选项'
            );
        }
    }
}
