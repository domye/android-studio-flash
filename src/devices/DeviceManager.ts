import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { AndroidSDKManager } from '../core/AndroidSDKManager';
import { exec, spawn, ChildProcess } from 'child_process';

const execAsync = promisify(exec);

/**
 * Represents an Android device (physical or emulator)
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
 * Manages Android device detection, selection, and operations.
 */
export class DeviceManager {
    private devices: AndroidDevice[] = [];
    private selectedDevice: AndroidDevice | null = null;
    private sdkManager: AndroidSDKManager;
    private onDidChangeDevicesEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeDevices = this.onDidChangeDevicesEmitter.event;
    private adbTracker: ChildProcess | null = null; // Reference to the tracking process    
    
    // Timer to prevent multiple refreshes at once
    private refreshTimeout: NodeJS.Timeout | undefined; 
    
    constructor() {
        this.sdkManager = new AndroidSDKManager();
         this.refreshDevices(); // Initial check
        this.startMonitoring(); // Start automatic detection
    }

        /**
     * Starts monitoring for device connection changes without polling.
     * Uses 'adb track-devices' which is efficient and event-driven.
     */
    startMonitoring(): void {
        const adbPath = this.sdkManager.getADBPath();
        
        // Spawn a persistent process
        this.adbTracker = spawn(adbPath, ['track-devices']);

        this.adbTracker.stdout?.on('data', () => {
            // إذا كان هناك مؤقت سابق، قم بإلغائه
            if (this.refreshTimeout) {
                clearTimeout(this.refreshTimeout);
            }

            // انتظر 500 مللي ثانية قبل التحديث، للتأكد من استقرار الاتصال
            this.refreshTimeout = setTimeout(() => {
                this.refreshDevices();
            }, 500);
        });

        this.adbTracker.on('error', (err) => {
            console.error('ADB Tracking Error:', err);
        });
    }

    /**
     * Refresh the list of connected devices
     */
    async refreshDevices(): Promise<void> {
        try {
            const adbPath = this.sdkManager.getADBPath();
            const { stdout } = await execAsync(`"${adbPath}" devices -l`);
            
            this.devices = [];
            const lines = stdout.split('\n');
            
            for (const line of lines) {
                if (line && !line.startsWith('List of devices') && line.trim()) {
                    // Example line:
                    // 5cda021f               device usb:1-1 product:RMX2061 model:RMX2061 device:RMX2061L1
                    const parts = line.split(/\s+/);
                    if (parts.length >= 2) {
                        const device: AndroidDevice = {
                            id: parts[0],
                            type: parts[0].startsWith('emulator-') ? 'emulator' : 'device',
                            state: parts[1] as any
                        };
                        
                        // Extract additional info from rest of line
                        // Looking for: model:xxx product:xxx device:xxx
                        const modelMatch = line.match(/model:([^\s]+)/);
                        const productMatch = line.match(/product:([^\s]+)/);
                        const deviceMatch = line.match(/device:([^\s]+)/);
                        
                        if (modelMatch) {
                            device.model = modelMatch[1].replace(/_/g, ' '); // Replace _ with spaces
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
                    this.selectedDevice = null; // الجهاز فُصل، احذف الاختيار
                } else {
                    this.selectedDevice = deviceStillConnected; // تحديث بياناته (مثل الحالة offline/online)
                }
            }


            if (!this.selectedDevice && this.devices.length > 0) {
                this.selectedDevice = this.devices[0];
            }

            this.onDidChangeDevicesEmitter.fire();
        } catch(error: any) {
            console.error('❌ Failed to refresh devices:', error);
            console.error('Error details:', error.message);
            
            this.devices = [];
            
            // Concise toast, details available in debug console
            vscode.window.showErrorMessage(`❌ ADB device refresh failed: ${error.message}. Check debug console for details.`);
        }
    }

    /**
     * Get list of connected devices
     */
    getDevices(): AndroidDevice[] {
        return this.devices;
    }

    /**
     * Get currently selected device
     */
    getSelectedDevice(): AndroidDevice | null {
        return this.selectedDevice;
    }

    /**
     * Select a device by its ID (used by tree view selection)
     */
    selectDeviceById(deviceId: string): void {
        const device = this.devices.find(d => d.id === deviceId);
        if (device) {
            this.selectedDevice = device;
            this.onDidChangeDevicesEmitter.fire();
        }
    }

    /**
     * Show device selection dialog
     */
    async selectDevice(): Promise<void> {
        if (this.devices.length === 0) {
            vscode.window.showWarningMessage('⚠️ No devices connected!');
            return;
        }

        const items = this.devices.map(device => ({
            label: this.getDeviceDisplayName(device),
            description: device.id,
            device: device
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a device'
        });

        if (selected) {
            this.selectedDevice = selected.device;
            this.onDidChangeDevicesEmitter.fire();
        }
    }

    /**
     * Get display name for a device
     */
    getDeviceDisplayName(device: AndroidDevice): string {
        const icon = device.type === 'emulator' ? '📱' : '🔌';
        const status = device.state === 'online' || device.state === 'device' ? '🟢' : '🔴';
        
        // Show real device name (model or product) instead of ID
        const name = device.model || device.product || device.device || device.id;
        
        return `${status} ${icon} ${name}`;
    }

    /**
     * Install APK on selected device
     */
    async installApk(apkPath: string): Promise<void> {
        const device = this.selectedDevice;
        if (!device) throw new Error('No device selected');

        const adbPath = this.sdkManager.getADBPath();
        await execAsync(`"${adbPath}" -s ${device.id} install -r "${apkPath}"`);
    }

    /**
     * Launch app on selected device
     */
    async launchApp(packageName: string, activityName: string): Promise<void> {
        const device = this.selectedDevice;
        if (!device) throw new Error('No device selected');

        const adbPath = this.sdkManager.getADBPath();
        const fullActivity = `${packageName}/${activityName}`;
        await execAsync(`"${adbPath}" -s ${device.id} shell am start -n ${fullActivity}`);
    }

    /**
     * Get package name from APK using aapt.
     * Falls back to extracting from the filename if aapt is unavailable.
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
        } catch { /* fall through */ }

        // Fallback: extract from filename
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
