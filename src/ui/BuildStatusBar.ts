import * as vscode from 'vscode';
import { DeviceManager } from '../devices/DeviceManager';

/**
 * 状态栏组件，显示当前设备和快速运行入口。
 */
export class BuildStatusBar {
    private runStatusBarItem: vscode.StatusBarItem;

    constructor(private deviceManager: DeviceManager) {
        this.runStatusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );

        this.runStatusBarItem.command = 'android.runApp';
        this.runStatusBarItem.tooltip = '构建并运行在设备上';
        this.runStatusBarItem.show();

        this.update();

        this.deviceManager.onDidChangeDevices(() => {
            this.update();
        });
    }

    /**
     * 显示临时构建状态（如构建进度）
     */
    showBuildStatus(message: string): void {
        this.runStatusBarItem.text = `[构建中] ${message}`;
    }

    /**
     * 恢复为正常设备显示
     */
    update() {
        const selectedDevice = this.deviceManager.getSelectedDevice();
        const devices = this.deviceManager.getDevices();

        if (selectedDevice) {
            const name = this.getDisplayName(selectedDevice);
            this.runStatusBarItem.text = `[运行] ${name}`;
            this.runStatusBarItem.tooltip = `在 ${name} (${selectedDevice.id}) 上运行`;
        } else if (devices.length > 0) {
            this.runStatusBarItem.text = '[运行] 选择设备';
            this.runStatusBarItem.tooltip = '点击选择设备';
        } else {
            this.runStatusBarItem.text = '[运行] 无设备';
            this.runStatusBarItem.tooltip = '没有已连接的设备';
        }
    }

    private getDisplayName(device: { id: string; type: string; model?: string; product?: string }): string {
        return device.model || device.product || device.id.substring(0, Math.min(device.id.length, 15));
    }

    dispose() {
        this.runStatusBarItem.dispose();
    }
}
