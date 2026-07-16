import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { AndroidSDKManager } from '../core/AndroidSDKManager';
import { exec, spawn, ChildProcess } from 'child_process';

const execAsync = promisify(exec);

/**
 * 表示一个 Android 设备（物理机或模拟器）
 */
export interface AndroidDevice {
    id: string;
    type: 'emulator' | 'device';
    state: 'device' | 'online' | 'offline' | 'unauthorized';
    model?: string;
    product?: string;
    device?: string;
}

/**
 * 管理 Android 设备检测、选择和操作。
 */
export class DeviceManager {
    private devices: AndroidDevice[] = [];
    private selectedDevice: AndroidDevice | null = null;
    private sdkManager: AndroidSDKManager;
    private onDidChangeDevicesEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeDevices = this.onDidChangeDevicesEmitter.event;
    private adbTracker: ChildProcess | null = null;

    // 防抖定时器，防止频繁刷新
    private refreshTimeout: NodeJS.Timeout | undefined;

    // 标记是否已尝试过自动连接 127.0.0.1，避免重复尝试
    private autoConnectLocalhostAttempted: boolean = false;

    constructor(sdkManager?: AndroidSDKManager) {
        this.sdkManager = sdkManager || new AndroidSDKManager();
        // 不立即刷新，由 startMonitoring 中的 track-devices 事件驱动
        this.startMonitoring();
    }

    /**
     * 通过 adb track-devices 事件驱动监听设备变化，无需轮询。
     */
    startMonitoring(): void {
        const adbPath = this.sdkManager.getADBPath();

        this.adbTracker = spawn(adbPath, ['track-devices']);

        this.adbTracker.stdout?.on('data', () => {
            if (this.refreshTimeout) {
                clearTimeout(this.refreshTimeout);
            }

            // 等待 500ms 确保连接稳定
            this.refreshTimeout = setTimeout(() => {
                this.refreshDevices();
            }, 500);
        });

        this.adbTracker.on('error', (err) => {
            console.error('ADB tracking error:', err);
        });
    }

    /**
     * 刷新已连接设备列表
     */
    async refreshDevices(): Promise<void> {
        try {
            const adbPath = this.sdkManager.getADBPath();
            const { stdout } = await execAsync(`"${adbPath}" devices -l`);

            this.devices = [];
            const lines = stdout.split('\n');

            for (const line of lines) {
                if (line && !line.startsWith('List of devices') && line.trim()) {
                    const parts = line.split(/\s+/);
                    if (parts.length >= 2) {
                        const device: AndroidDevice = {
                            id: parts[0],
                            type: parts[0].startsWith('emulator-') ? 'emulator' : 'device',
                            state: parts[1] as any
                        };

                        const modelMatch = line.match(/model:([^\s]+)/);
                        const productMatch = line.match(/product:([^\s]+)/);
                        const deviceMatch = line.match(/device:([^\s]+)/);

                        if (modelMatch) {
                            device.model = modelMatch[1].replace(/_/g, ' ');
                        }
                        if (productMatch) {
                            device.product = productMatch[1];
                        }
                        if (deviceMatch) {
                            device.device = deviceMatch[1];
                        }

                        this.devices.push(device);
                    }
                }
            }

            if (this.selectedDevice) {
                const deviceStillConnected = this.devices.find(d => d.id === this.selectedDevice?.id);
                if (!deviceStillConnected) {
                    this.selectedDevice = null;
                } else {
                    this.selectedDevice = deviceStillConnected;
                }
            }

            if (!this.selectedDevice && this.devices.length > 0) {
                this.selectedDevice = this.devices[0];
            }

            // 自动检测 127.0.0.1:5555：无设备时尝试连接本地 ADB
            if (this.devices.length === 0 && !this.autoConnectLocalhostAttempted) {
                this.autoConnectLocalhostAttempted = true;
                const adbPath = this.sdkManager.getADBPath();
                execAsync(`"${adbPath}" connect 127.0.0.1:5555`, { timeout: 3000 })
                    .then(() => {
                        // 连接成功，刷新设备列表
                        this.autoConnectLocalhostAttempted = false; // 允许下次再次尝试
                        return this.refreshDevices();
                    })
                    .catch(() => {
                        // 连接失败（无本地 ADB 守护进程），静默忽略
                        console.log('未发现本地 ADB 守护进程 (127.0.0.1:5555)');
                    });
            }

            this.onDidChangeDevicesEmitter.fire();
        } catch(error: any) {
            console.error('刷新设备失败:', error);

            this.devices = [];

            vscode.window.showErrorMessage(`ADB 设备刷新失败: ${error.message}。查看调试控制台获取详细信息。`);
        }
    }

    /**
     * 获取已连接设备列表
     */
    getDevices(): AndroidDevice[] {
        return this.devices;
    }

    /**
     * 获取当前选中的设备
     */
    getSelectedDevice(): AndroidDevice | null {
        return this.selectedDevice;
    }

    /**
     * 根据设备 ID 选中设备（供 Tree View 使用）
     */
    selectDeviceById(deviceId: string): void {
        const device = this.devices.find(d => d.id === deviceId);
        if (device) {
            this.selectedDevice = device;
            this.onDidChangeDevicesEmitter.fire();
        }
    }

    /**
     * 弹出设备选择对话框
     */
    async selectDevice(): Promise<void> {
        if (this.devices.length === 0) {
            vscode.window.showWarningMessage('没有已连接的设备！');
            return;
        }

        const items = this.devices.map(device => ({
            label: this.getDeviceDisplayName(device),
            description: device.id,
            device: device
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '选择设备'
        });

        if (selected) {
            this.selectedDevice = selected.device;
            this.onDidChangeDevicesEmitter.fire();
        }
    }

    /**
     * 获取设备显示名称
     */
    getDeviceDisplayName(device: AndroidDevice): string {
        const icon = device.type === 'emulator' ? '[Emulator]' : '[Device]';
        const status = device.state === 'online' || device.state === 'device' ? '[Online]' : '[Offline]';

        const name = device.model || device.product || device.device || device.id;

        return `${status} ${icon} ${name}`;
    }

    /**
     * 在选定设备上安装 APK
     */
    async installApk(apkPath: string): Promise<void> {
        const device = this.selectedDevice;
        if (!device) throw new Error('No device selected');

        const adbPath = this.sdkManager.getADBPath();
        await execAsync(`"${adbPath}" -s ${device.id} install -r "${apkPath}"`);
    }

    /**
     * 在选定设备上启动应用
     */
    async launchApp(packageName: string, activityName: string): Promise<void> {
        const device = this.selectedDevice;
        if (!device) throw new Error('No device selected');

        const adbPath = this.sdkManager.getADBPath();
        const fullActivity = `${packageName}/${activityName}`;
        await execAsync(`"${adbPath}" -s ${device.id} shell am start -n ${fullActivity}`);
    }

    /**
     * 从 APK 中获取包名（使用 aapt）
     * 若 aapt 不可用则从文件名推断
     */
    async getPackageName(apkPath: string): Promise<string> {
        try {
            const adbPath = this.sdkManager.getADBPath();
            const sdkDir = path.dirname(path.dirname(adbPath));
            const buildToolsDir = path.join(sdkDir, 'build-tools');

            if (fs.existsSync(buildToolsDir)) {
                const versions = fs.readdirSync(buildToolsDir).sort().reverse();
                for (const ver of versions) {
                    const aaptPath = path.join(buildToolsDir, ver, process.platform === 'win32' ? 'aapt.exe' : 'aapt');
                    if (fs.existsSync(aaptPath)) {
                        const { stdout } = await execAsync(`"${aaptPath}" dump badging "${apkPath}"`);
                        const match = stdout.match(/package:\s*name='([^']+)'/);
                        if (match?.[1]) return match[1];
                    }
                }
            }
        } catch { /* 静默降级 */ }

        // 降级：从文件名提取
        const basename = path.basename(apkPath).replace(/-debug|-release|-unsigned/g, '').replace(/\.apk$/, '');
        return basename;
    }

    dispose() {
        if (this.adbTracker) {
            this.adbTracker.kill();
            this.adbTracker = null;
        }
        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
        }
        this.onDidChangeDevicesEmitter.dispose();
    }
}
