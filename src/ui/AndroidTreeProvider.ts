import * as vscode from 'vscode';
import { DeviceManager, AndroidDevice } from '../devices/DeviceManager';
import { BuildSystem } from '../build/BuildSystem';
import { LogcatManager } from '../logcat/LogcatManager';
import { WirelessADBManager } from '../wireless/WirelessADBManager';
import { GradleService } from '../core/GradleService';
import { GradleModuleService } from '../core/GradleModuleService';

type TreeItemType = 'header' | 'device' | 'action' | 'empty' | 'wireless-device' | 'module';

/**
 * Tree data provider for the Android Control Panel in the sidebar.
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
            // Root elements
            return [
                // Build Actions section
                new AndroidTreeItem('构建操作', '', 'header', vscode.TreeItemCollapsibleState.Expanded),

                // Devices section (Now includes wireless controls)
                new AndroidTreeItem('设备', '', 'header', vscode.TreeItemCollapsibleState.Expanded),
                
                // Note: "Wireless Devices" folder has been removed as requested
                
                // Tools section
                new AndroidTreeItem('工具', '', 'header', vscode.TreeItemCollapsibleState.Expanded)
            ];
        }

        // Children based on section
        if (element.label === '构建操作') {
            const children: AndroidTreeItem[] = [];

            // 1. Module Selector (Nested Folder)
            const currentModule = this.gradleService.getTargetModule() || '(项目根目录)';
            
            // This item acts as a folder containing the modules
            const moduleItem = new AndroidTreeItem(
                `目标模块: ${currentModule}`, 
                '', 
                'header', // Use header type for folder icon behavior or customized below
                vscode.TreeItemCollapsibleState.Collapsed
            );
            moduleItem.contextValue = 'androidModuleGroup'; // Special context if needed
            children.push(moduleItem);

            // 2. Build Commands
            children.push(new AndroidTreeItem('构建并运行', 'android.runApp', 'action'));
            children.push(new AndroidTreeItem('构建 Debug APK', 'android.buildDebug', 'action'));
            children.push(new AndroidTreeItem('构建 Release APK', 'android.buildRelease', 'action'));
            children.push(new AndroidTreeItem('清理项目', 'android.cleanProject', 'action'));
            children.push(new AndroidTreeItem('同步 Gradle', 'android.syncGradle', 'action'));

            return children;
        }

        // Handle the "Target" item specifically
        if (element.label.startsWith('目标模块:')) {
            const items: AndroidTreeItem[] = [];
            try {
                const root = this.gradleService.findProjectRoot();
                const modules = await this.gradleModuleService.getModules(root);
                const currentModule = this.gradleService.getTargetModule(); // null means Project Root

                // Add Project Root explicitly if not in list
                if (!modules.includes('(项目根目录)')) {
                    modules.unshift('(项目根目录)');
                }

                modules.forEach(module => {
                    // Check if this module is selected
                    const isSelected = (module === '(项目根目录)' && currentModule === null) || 
                                       (module === currentModule);
                    
                    const label = isSelected ? `✓ ${module}` : module;
                    
                    const item = new AndroidTreeItem(label, module, 'module');
                    item.moduleName = module; // Custom property
                    item.contextValue = 'androidModule';
                    
                    // Command to select this module
                    item.command = {
                        command: 'android.selectModuleFromTree',
                        title: '选择模块',
                        arguments: [module]
                    };
                    
                    if (isSelected) {
                        item.description = '当前';
                    }

                    items.push(item);
                });
            } catch (error) {
                items.push(new AndroidTreeItem('加载模块出错', '', 'empty'));
            }
            return items;
        }

        if (element.label === '设备') {
            const items: AndroidTreeItem[] = [];
            const devices = this.deviceManager.getDevices();
            const selectedDevice = this.deviceManager.getSelectedDevice();

            // 1. List all connected devices (USB + Wireless)
            if (devices.length > 0) {
                devices.forEach(device => {
                    const isSelected = selectedDevice?.id === device.id;
                    const label = this.getDeviceLabel(device, isSelected);
                    const item = new AndroidTreeItem(label, device.id, 'device');
                    item.device = device;
                    if (device.id.includes(':')) {
                        item.contextValue = 'connectedWirelessDevice';
                        item.tooltip = `无线设备 (已连接) - 点击选择`;
                    }
                    item.command = {
                        command: 'android.selectDeviceFromTree',
                        title: '选择设备',
                        arguments: [device]
                    };
                    items.push(item);
                });
            }

            // 2. List saved wireless devices that are not currently connected
            try {
                const savedWireless = await this.wirelessManager.getSavedDevices();
                const connectedIds = new Set(devices.map(d => d.id));
                const connectedIps = new Set(devices.filter(d => d.id.includes(':')).map(d => d.id.split(':')[0]));
                
                const disconnectedSaved = savedWireless.filter(saved => 
                    !connectedIds.has(saved.id) && (!saved.ipAddress || !connectedIps.has(saved.ipAddress))
                );
                
                if (disconnectedSaved.length > 0) {
                    disconnectedSaved.forEach(saved => {
                        const name = saved.model || `${saved.ipAddress}:${saved.port}`;
                        const label = `🔴 📡 [已保存] ${name}`;
                        const item = new AndroidTreeItem(label, saved.id, 'wireless-device');
                        item.device = {
                            id: saved.id,
                            type: 'device',
                            state: 'offline',
                            model: saved.model,
                            ipAddress: saved.ipAddress,
                            port: saved.port
                        } as any;
                        item.command = {
                            command: 'android.reconnectWirelessDevice',
                            title: '重新连接设备',
                            arguments: [saved]
                        };
                        items.push(item);
                    });
                }
            } catch (error) {
                console.error('加载已保存无线设备失败:', error);
            }

            // If no devices connected and no saved devices, show an information item
            if (items.length === 0) {
                items.push(new AndroidTreeItem('没有已连接的设备', '', 'empty'));
            }

            // 3. Add Wireless Device Option (Moved here as requested)
            items.push(new AndroidTreeItem('添加无线设备', 'android.setupWireless', 'action'));

            // 4. Reload Devices Option (Moved here as requested)
            items.push(new AndroidTreeItem('刷新设备', 'android.refreshDevices', 'action'));

            return items;
        }

        // Note: The "Wireless Devices" block has been completely removed.

        if (element.label === '工具') {
            return [
                new AndroidTreeItem('显示 Logcat', 'android.showLogcat', 'action'),
                new AndroidTreeItem('Logcat 过滤模式', 'android.toggleLogcatFilter', 'action'),
                new AndroidTreeItem('清空 Logcat', 'android.clearLogcat', 'action'),
                new AndroidTreeItem('停止 Logcat', 'android.stopLogcat', 'action'),
                new AndroidTreeItem('创建签名密钥', 'android.createKeystore', 'action'),
                new AndroidTreeItem('运行诊断', 'android.runDiagnostics', 'action')
            ];
        }

        return [];
    }

    /**
     * Get device label with status and type icons
     */
    private getDeviceLabel(device: AndroidDevice, isSelected: boolean): string {
        const statusIcon = device.state === 'online' || device.state === 'device' ? '[在线]' : '[离线]';
        
        // Determine type icon based on device type
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
 * Tree item for the Android Control Panel
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
        } else if (itemType === 'wireless-device') {
            this.contextValue = 'disconnectedWirelessDevice';
            this.tooltip = `点击重新连接此设备`;
            this.iconPath = new vscode.ThemeIcon('circle-outline');
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