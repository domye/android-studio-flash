import * as vscode from 'vscode';
import { DeviceManager } from '../devices/DeviceManager';

/**
 * Status bar item that shows the current device and provides quick run access.
 */
export class BuildStatusBar {
    private runStatusBarItem: vscode.StatusBarItem;

    constructor(private deviceManager: DeviceManager) {
        this.runStatusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );

        this.runStatusBarItem.command = 'android.runApp';
        this.runStatusBarItem.tooltip = 'Build and Run on device';
        this.runStatusBarItem.show();

        this.update();

        this.deviceManager.onDidChangeDevices(() => {
            this.update();
        });
    }

    /**
     * Show a temporary status message (e.g. build progress).
     */
    showBuildStatus(message: string): void {
        this.runStatusBarItem.text = `$(sync~spin) ${message}`;
    }

    /**
     * Restore to normal device display.
     */
    update() {
        const selectedDevice = this.deviceManager.getSelectedDevice();
        const devices = this.deviceManager.getDevices();

        if (selectedDevice) {
            const icon = selectedDevice.type === 'emulator' ? '$(device-mobile)' : '$(device-camera)';
            const name = this.getDisplayName(selectedDevice);
            this.runStatusBarItem.text = `${icon} ▶️ ${name}`;
            this.runStatusBarItem.tooltip = `Run on ${name} (${selectedDevice.id})`;
        } else if (devices.length > 0) {
            this.runStatusBarItem.text = '$(warning) ▶️ Select Device';
            this.runStatusBarItem.tooltip = 'Click to select a device';
        } else {
            this.runStatusBarItem.text = '$(warning) ▶️ No Device';
            this.runStatusBarItem.tooltip = 'No devices connected';
        }
    }

    private getDisplayName(device: { id: string; type: string; model?: string; product?: string }): string {
        // Prefer model name, then product, then first 15 chars of ID
        return device.model || device.product || device.id.substring(0, Math.min(device.id.length, 15));
    }

    dispose() {
        this.runStatusBarItem.dispose();
    }
}
