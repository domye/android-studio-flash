import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { WirelessDebugger } from './WirelessDebugger';
import { TcpIpConnector } from './TcpIpConnector';
import { AndroidDevice } from '../devices/DeviceManager';

const execAsync = promisify(exec);

/**
 * 无线连接的 Android 设备
 */
export interface WirelessDevice extends AndroidDevice {
    connectionType: 'wireless-debug' | 'tcpip';
    ipAddress: string;
    port: number;
    paired?: boolean;
    lastConnected?: number;
}

/**
 * 持久化保存的无线设备配置
 */
interface SavedWirelessDevice {
    id: string;
    ipAddress: string;
    port: number;
    connectionType: 'wireless-debug' | 'tcpip';
    model?: string;
    lastConnected: number;
}

/**
 * 管理无线 ADB 连接，包括 Wireless Debugging（Android 11+）和 TCP/IP。
 */
export class WirelessADBManager {
    private wirelessDebugger: WirelessDebugger;
    private tcpIpConnector: TcpIpConnector;
    private wirelessDevices: WirelessDevice[] = [];
    private onDidChangeDevicesEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeDevices = this.onDidChangeDevicesEmitter.event;
    private readonly STORAGE_KEY = 'android.wirelessDevices';

    constructor(
        private adbPath: string,
        private context: vscode.ExtensionContext
    ) {
        this.wirelessDebugger = new WirelessDebugger(adbPath);
        this.tcpIpConnector = new TcpIpConnector(adbPath);
    }

    /**
     * 打开无线连接设置向导
     */
    async setupWirelessConnection(): Promise<void> {
        const method = await this.promptConnectionMethod();

        if (!method) {
            return;
        }

        switch (method) {
            case 'wireless-debug':
                await this.setupWirelessDebugging();
                break;
            case 'tcpip':
                await this.setupTcpIp();
                break;
        }
    }

    /**
     * 选择连接方式
     */
    private async promptConnectionMethod(): Promise<'wireless-debug' | 'tcpip' | null> {
        const items = [
            {
                label: '无线调试',
                description: 'Android 11+ - 最简单',
                detail: '使用二维码或配对码',
                method: 'wireless-debug' as const
            },
            {
                label: 'ADB over TCP/IP',
                description: 'Android 4.0+ - 需要一次 USB 连接',
                detail: '适用于旧设备',
                method: 'tcpip' as const
            }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '选择无线连接方式'
        });

        return selected?.method || null;
    }

    /**
     * 设置 Wireless Debugging（Android 11+）
     */
    private async setupWirelessDebugging(): Promise<void> {
        const pairingMethod = await this.wirelessDebugger.promptPairingMethod();

        if (!pairingMethod) {
            return;
        }

        if (pairingMethod === 'pairing-code') {
            await this.wirelessDebugger.pairWithCode();
        } else {
            vscode.window.showInformationMessage(
                '二维码配对即将支持。请先使用配对码。'
            );
        }

        this.onDidChangeDevicesEmitter.fire();
    }

    /**
     * 设置 ADB over TCP/IP
     */
    private async setupTcpIp(): Promise<void> {
        await this.tcpIpConnector.setupConnection();
        this.onDidChangeDevicesEmitter.fire();
    }

    /**
     * 保存所有当前无线设备
     */
    private async saveWirelessDevices(): Promise<void> {
        try {
            const savedDevices: SavedWirelessDevice[] = this.wirelessDevices.map(device => ({
                id: device.id,
                ipAddress: device.ipAddress,
                port: device.port,
                connectionType: device.connectionType,
                model: device.model,
                lastConnected: Date.now()
            }));

            await this.context.globalState.update(this.STORAGE_KEY, savedDevices);
            console.log(`Saved ${savedDevices.length} wireless devices`);
        } catch (error) {
            console.error('Failed to save wireless devices:', error);
        }
    }

    /**
     * 从存储中加载已保存的设备
     */
    private async loadWirelessDevices(): Promise<SavedWirelessDevice[]> {
        try {
            const saved = this.context.globalState.get<SavedWirelessDevice[]>(this.STORAGE_KEY, []);
            console.log(`Loaded ${saved.length} saved wireless devices`);
            return saved;
        } catch (error) {
            console.error('Failed to load wireless devices:', error);
            return [];
        }
    }

    /**
     * 添加设备到已保存列表
     */
    async addSavedDevice(device: WirelessDevice): Promise<void> {
        try {
            const saved = await this.loadWirelessDevices();

            const filtered = saved.filter(d => d.id !== device.id);

            filtered.push({
                id: device.id,
                ipAddress: device.ipAddress,
                port: device.port,
                connectionType: device.connectionType,
                model: device.model,
                lastConnected: Date.now()
            });

            await this.context.globalState.update(this.STORAGE_KEY, filtered);
            console.log(`Added device to saved list: ${device.id}`);
        } catch (error) {
            console.error('Failed to add saved device:', error);
        }
    }

    /**
     * 从已保存列表移除设备
     */
    async removeSavedDevice(deviceId: string): Promise<void> {
        try {
            const saved = await this.loadWirelessDevices();
            const filtered = saved.filter(d => d.id !== deviceId);
            await this.context.globalState.update(this.STORAGE_KEY, filtered);
            console.log(`Removed device from saved list: ${deviceId}`);

            vscode.window.showInformationMessage(`已忘记设备: ${deviceId}`);
        } catch (error) {
            console.error('Failed to remove saved device:', error);
        }
    }

    /**
     * 启动时自动重连已保存的设备
     */
    async autoReconnectSavedDevices(): Promise<void> {
        const saved = await this.loadWirelessDevices();

        if (saved.length === 0) {
            console.log('No saved wireless devices to reconnect');
            return;
        }

        console.log(`Attempting to reconnect ${saved.length} saved devices...`);

        const reconnectPromises = saved.map(device =>
            this.attemptReconnect(device)
        );

        const results = await Promise.allSettled(reconnectPromises);

        const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
        const failCount = results.length - successCount;

        if (successCount > 0) {
            console.log(`Reconnected ${successCount} device(s)`);
        }
        if (failCount > 0) {
            console.warn(`Failed to reconnect ${failCount} device(s)`);
        }

        this.onDidChangeDevicesEmitter.fire();
    }

    /**
     * 尝试重连单个设备
     */
    private async attemptReconnect(savedDevice: SavedWirelessDevice): Promise<boolean> {
        const endpoint = `${savedDevice.ipAddress}:${savedDevice.port}`;

        try {
            await execAsync(`"${this.adbPath}" connect ${endpoint}`, {
                timeout: 5000
            });

            console.log(`Reconnected: ${endpoint}`);
            return true;

        } catch (error: any) {
            console.warn(`Failed to reconnect ${endpoint}: ${error.message}`);
            return false;
        }
    }

    /**
     * 根据端口号判断连接类型
     */
    private detectConnectionType(port: number): 'wireless-debug' | 'tcpip' {
        return port === 5555 ? 'tcpip' : 'wireless-debug';
    }

    /**
     * 断开无线设备
     */
    async disconnectDevice(device: WirelessDevice): Promise<void> {
        const endpoint = `${device.ipAddress}:${device.port}`;

        try {
            await execAsync(`"${this.adbPath}" disconnect ${endpoint}`);

            this.wirelessDevices = this.wirelessDevices.filter(d => d.id !== device.id);

            vscode.window.showInformationMessage(`已断开: ${device.model || endpoint}`);
            this.onDidChangeDevicesEmitter.fire();
        } catch (error: any) {
            vscode.window.showErrorMessage(`断开失败: ${error.message}`);
        }
    }

    /**
     * 获取已连接的无线设备列表
     */
    getWirelessDevices(): WirelessDevice[] {
        return this.wirelessDevices;
    }

    /**
     * 刷新无线设备列表
     */
    async refreshWirelessDevices(): Promise<void> {
        try {
            const { stdout } = await execAsync(`"${this.adbPath}" devices -l`);
            const lines = stdout.split('\n');

            this.wirelessDevices = [];

            for (const line of lines) {
                if (line && !line.startsWith('List of devices') && line.trim()) {
                    if (line.includes(':')) {
                        const parts = line.split(/\s+/);
                        if (parts.length >= 2) {
                            const endpoint = parts[0];
                            const [ip, port] = endpoint.split(':');

                            const modelMatch = line.match(/model:([^\s]+)/);
                            const productMatch = line.match(/product:([^\s]+)/);
                            const deviceMatch = line.match(/device:([^\s]+)/);

                            const portNumber = parseInt(port);
                            const device: WirelessDevice = {
                                id: endpoint,
                                type: 'device',
                                state: parts[1] as any,
                                connectionType: this.detectConnectionType(portNumber),
                                ipAddress: ip,
                                port: portNumber,
                                model: modelMatch ? modelMatch[1].replace(/_/g, ' ') : undefined,
                                product: productMatch ? productMatch[1] : undefined,
                                device: deviceMatch ? deviceMatch[1] : undefined,
                                lastConnected: Date.now()
                            };

                            this.wirelessDevices.push(device);

                            if (device.state === 'device') {
                                await this.addSavedDevice(device);
                            }
                        }
                    }
                }
            }

            this.onDidChangeDevicesEmitter.fire();
        } catch (error) {
            console.error('Failed to refresh wireless devices:', error);
        }
    }

    dispose() {
        this.onDidChangeDevicesEmitter.dispose();
    }
}
