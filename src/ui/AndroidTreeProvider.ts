import * as vscode from 'vscode';
import { DeviceManager, AndroidDevice } from '../devices/DeviceManager';
import { BuildSystem } from '../build/BuildSystem';
import { LogcatManager } from '../logcat/LogcatManager';
import { WirelessADBManager } from '../wireless/WirelessADBManager';
import { GradleService } from '../core/GradleService';
import { GradleModuleService } from '../core/GradleModuleService';

type TreeItemType = 'header' | 'device' | 'action' | 'empty' | 'wireless-device' | 'module';

// TreeView 节点标签常量，消除硬编码字符串路由
const TREE_SECTIONS = {
    BUILD: '构建操作',
    DEVICES: '设备',
    TOOLS: '工具',
    MODULE_PREFIX: '目标模块:',
} as const;

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
                new AndroidTreeItem(TREE_SECTIONS.BUILD, '', 'header', vscode.TreeItemCollapsibleState.Expanded),
                new AndroidTreeItem(TREE_SECTIONS.DEVICES, '', 'header', vscode.TreeItemCollapsibleState.Expanded),
                new AndroidTreeItem(TREE_SECTIONS.TOOLS, '', 'header', vscode.TreeItemCollapsibleState.Expanded)
            ];
        }

        if (element.label === TREE_SECTIONS.BUILD) {
            const children: AndroidTreeItem[] = [];

            const currentModule = this.gradleService.getTargetModule() || '(项目根目录)';

            const moduleItem = new AndroidTreeItem(
                `${TREE_SECTIONS.MODULE_PREFIX} ${currentModule}`,
                '',
                'header',
                vscode.TreeItemCollapsibleState.Collapsed
            );
            moduleItem.contextValue = 'androidModuleGroup';
            children.push(moduleItem);

            children.push(new AndroidTreeItem('构建并运行', 'android.runApp', 'action'));
            children.push(new AndroidTreeItem('构建 Debug APK', 'android.buildDebug', 'action'));
            children.push(new AndroidTreeItem('构建 Release APK', 'android.buildRelease', 'action'));
            children.push(new AndroidTreeItem('清理项目', 'android.cleanProject', 'action'));
            children.push(new AndroidTreeItem('同步 Gradle', 'android.syncGradle', 'action'));

            return children;
        }

        if (element.label && element.label.startsWith(TREE_SECTIONS.MODULE_PREFIX)) {
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
                        title: '选择模块',
                        arguments: [module]
                    };

                    if (isSelected) {
                        item.description = '当前';
                    }

                    items.push(item);
                });
            } catch {
                items.push(new AndroidTreeItem('加载模块出错', '', 'empty'));
            }
            return items;
        }

        if (element.label === TREE_SECTIONS.DEVICES) {
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
                        title: '选择设备',
                        arguments: [device]
                    };
                    items.push(item);
                });
            } else {
                items.push(new AndroidTreeItem('没有已连接的设备', '', 'empty'));
            }

            items.push(new AndroidTreeItem('添加无线设备', 'android.setupWireless', 'action'));
            items.push(new AndroidTreeItem('刷新设备', 'android.refreshDevices', 'action'));

            return items;
        }

        if (element.label === TREE_SECTIONS.TOOLS) {
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
