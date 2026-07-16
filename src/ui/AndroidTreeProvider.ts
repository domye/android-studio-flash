import * as vscode from 'vscode';
import { DeviceManager, AndroidDevice } from '../devices/DeviceManager';
import { BuildSystem } from '../build/BuildSystem';
import { LogcatManager } from '../logcat/LogcatManager';
import { WirelessADBManager } from '../wireless/WirelessADBManager';
import { GradleService } from '../core/GradleService';
import { GradleModuleService } from '../core/GradleModuleService';

type TreeItemType = 'header' | 'device' | 'action' | 'empty' | 'wireless-device' | 'module';

/**
 * Android 控制面板的树形数据提供者
 */
export class AndroidTreeProvider implements vscode.TreeDataProvider<AndroidTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<AndroidTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private deviceManager: DeviceManager,
        private buildSystem: BuildSystem,
        private logcatManager: LogcatManager,
        private wirelessManager: WirelessADBManager,
        private gradleService: GradleService,
        private gradleModuleService: GradleModuleService
    ) {
        this.deviceManager.onDidChangeDevices(() => {
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: AndroidTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: AndroidTreeItem): Promise<AndroidTreeItem[]> {
        if (!element) {
            return [
                new AndroidTreeItem('Build Actions', '', 'header', vscode.TreeItemCollapsibleState.Expanded),
                new AndroidTreeItem('Devices', '', 'header', vscode.TreeItemCollapsibleState.Expanded),
                new AndroidTreeItem('Tools', '', 'header', vscode.TreeItemCollapsibleState.Expanded)
            ];
        }

        if (element.label === 'Build Actions') {
            const children: AndroidTreeItem[] = [];

            const currentModule = this.gradleService.getTargetModule() || '(项目根目录)';

            const moduleItem = new AndroidTreeItem(
                `Target: ${currentModule}`,
                '',
                'header',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            moduleItem.contextValue = 'androidModuleGroup';
            children.push(moduleItem);

            children.push(new AndroidTreeItem('Build & Run', 'android.runApp', 'action'));
            children.push(new AndroidTreeItem('Build Debug APK', 'android.buildDebug', 'action'));
            children.push(new AndroidTreeItem('Build Release APK', 'android.buildRelease', 'action'));
            children.push(new AndroidTreeItem('Clean Project', 'android.cleanProject', 'action'));
            children.push(new AndroidTreeItem('Sync Gradle', 'android.syncGradle', 'action'));

            return children;
        }

        if (element.label.startsWith('Target:')) {
            const items: AndroidTreeItem[] = [];
            try {
                const root = this.gradleService.findProjectRoot();
                const modules = await this.gradleModuleService.getModules(root);
                const currentModule = this.gradleService.getTargetModule();

                if (!modules.includes('(项目根目录)')) {
                    modules.unshift('(项目根目录)');
                }

                modules.forEach(module => {
                    const isSelected = (module === '(项目根目录)' && currentModule === null) ||
                                       (module === currentModule);

                    const label = isSelected ? `* ${module}` : module;

                    const item = new AndroidTreeItem(label, module, 'module');
                    item.moduleName = module;
                    item.contextValue = 'androidModule';

                    item.command = {
                        command: 'android.selectModuleFromTree',
                        title: 'Select Module',
                        arguments: [module]
                    };

                    if (isSelected) {
                        item.description = 'Active';
                    }

                    items.push(item);
                });
            } catch (error) {
                items.push(new AndroidTreeItem('Error loading modules', '', 'empty'));
            }
            return items;
        }

        if (element.label === 'Devices') {
            const items: AndroidTreeItem[] = [];
            const devices = this.deviceManager.getDevices();
            const selectedDevice = this.deviceManager.getSelectedDevice();

            if (devices.length > 0) {
                devices.forEach(device => {
                    const isSelected = selectedDevice?.id === device.id;
                    const label = this.getDeviceLabel(device, isSelected);
                    const item = new AndroidTreeItem(label, device.id, 'device');
                    item.device = device;
                    item.command = {
                        command: 'android.selectDeviceFromTree',
                        title: 'Select Device',
                        arguments: [device]
                    };
                    items.push(item);
                });
            } else {
                items.push(new AndroidTreeItem('No devices connected', '', 'empty'));
            }

            items.push(new AndroidTreeItem('Add Wireless Device', 'android.setupWireless', 'action'));
            items.push(new AndroidTreeItem('Refresh Devices', 'android.refreshDevices', 'action'));

            return items;
        }

        if (element.label === 'Tools') {
            return [
                new AndroidTreeItem('Show Logcat', 'android.showLogcat', 'action'),
                new AndroidTreeItem('Logcat Filter Mode', 'android.toggleLogcatFilter', 'action'),
                new AndroidTreeItem('Clear Logcat', 'android.clearLogcat', 'action'),
                new AndroidTreeItem('Stop Logcat', 'android.stopLogcat', 'action'),
                new AndroidTreeItem('Create Signing Key', 'android.createKeystore', 'action'),
                new AndroidTreeItem('Run Diagnostics', 'android.runDiagnostics', 'action')
            ];
        }

        return [];
    }

    /**
     * 获取设备标签（包含状态和类型）
     */
    private getDeviceLabel(device: AndroidDevice, isSelected: boolean): string {
        const statusIcon = device.state === 'online' || device.state === 'device' ? '[在线]' : '[离线]';

        let typeIcon: string;
        if (device.type === 'emulator') {
            typeIcon = '[模拟器]';
        } else if (device.id.includes(':')) {
            typeIcon = '[无线]';
        } else {
            typeIcon = '[USB]';
        }

        const selectedMark = isSelected ? '* ' : '  ';
        const name = device.model || device.product || device.id.substring(0, 15);

        return `${selectedMark}${statusIcon} ${typeIcon} ${name}`;
    }
}

/**
 * Android 控制面板的树节点
 */
class AndroidTreeItem extends vscode.TreeItem {
    public device?: AndroidDevice;
    public moduleName?: string;

    constructor(
        public readonly label: string,
        public readonly resourceId: string,
        public readonly itemType: TreeItemType,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(label, collapsibleState);

        if (itemType === 'action') {
            this.command = {
                command: resourceId,
                title: label
            };
            this.iconPath = new vscode.ThemeIcon('play-circle');
            this.contextValue = 'androidAction';
        } else if (itemType === 'device') {
            this.contextValue = 'androidDevice';
            this.tooltip = `点击选择此设备`;
        } else if (itemType === 'module') {
            this.contextValue = 'androidModule';
            this.iconPath = new vscode.ThemeIcon('package');
        } else if (itemType === 'header') {
            this.contextValue = 'androidHeader';
            this.iconPath = new vscode.ThemeIcon('folder');
        } else if (itemType === 'empty') {
            this.iconPath = new vscode.ThemeIcon('warning');
        }
    }
}
