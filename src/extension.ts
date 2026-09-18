import * as vscode from 'vscode';
import { AndroidSDKManager } from './core/AndroidSDKManager';
import { GradleService } from './core/GradleService';
import { GradleModuleService } from './core/GradleModuleService';
import { DeviceManager } from './devices/DeviceManager';
import { AndroidTreeProvider } from './ui/AndroidTreeProvider';
import { BuildSystem } from './build/BuildSystem';
import { BuildStatusBar } from './ui/BuildStatusBar';
import { LogcatManager } from './logcat/LogcatManager';
import { WirelessADBManager } from './wireless/WirelessADBManager';
import { KeystoreManager } from './signing/KeystoreManager';
import { SigningWizard } from './signing/SigningWizard';

let deviceManager: DeviceManager;
let buildSystem: BuildSystem;
let statusBar: BuildStatusBar;
let logcatManager: LogcatManager;
let treeProvider: AndroidTreeProvider;
let wirelessManager: WirelessADBManager;

export async function activate(context: vscode.ExtensionContext) {
    console.log('Android Studio Flash 已激活!');

    try {
        // Initialize core components
        const sdkManager = new AndroidSDKManager();
        const gradleService = new GradleService(sdkManager);
        const gradleModuleService = new GradleModuleService(); // New Service
        deviceManager = new DeviceManager();
        buildSystem = new BuildSystem(gradleService, deviceManager);
        logcatManager = new LogcatManager(deviceManager);
        wirelessManager = new WirelessADBManager(sdkManager.getADBPath(), context);

        // Auto-save newly connected wireless devices with debouncing to prevent event storms
        let autoSaveTimeout: NodeJS.Timeout | undefined;
        deviceManager.onDidChangeDevices(() => {
            if (autoSaveTimeout) {
                clearTimeout(autoSaveTimeout);
            }
            autoSaveTimeout = setTimeout(async () => {
                const connectedDevices = deviceManager.getDevices();
                for (const device of connectedDevices) {
                    if (device.id.includes(':') && (device.state === 'device' || device.state === 'online')) {
                        const [ip, portStr] = device.id.split(':');
                        const port = parseInt(portStr) || 5555;
                        await wirelessManager.addSavedDevice({
                            id: device.id,
                            ipAddress: ip,
                            port: port,
                            connectionType: port === 5555 ? 'tcpip' : 'wireless-debug',
                            model: device.model,
                            product: device.product,
                            device: device.device,
                            state: device.state,
                            type: 'device'
                        });
                    }
                }
            }, 300);
        });

        // Initialize signing components
        const keystoreManager = new KeystoreManager(context);
        const signingWizard = new SigningWizard(keystoreManager);
        buildSystem.setSigningWizard(signingWizard);

        // Initialize UI components
        statusBar = new BuildStatusBar(deviceManager);
        treeProvider = new AndroidTreeProvider(
            deviceManager, 
            buildSystem, 
            logcatManager, 
            wirelessManager,
            gradleService,
            gradleModuleService
        );

        // Module Selection Status Bar
        const moduleStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        moduleStatusBar.command = 'android.selectModule';
        context.subscriptions.push(moduleStatusBar);

        // Restore saved module selection
        const savedModule = context.workspaceState.get<string>('android-studio-flash.selectedModule');
        if (savedModule) {
            gradleService.setTargetModule(savedModule);
            moduleStatusBar.text = `模块: ${savedModule}`;
        } else {
            moduleStatusBar.text = '模块: (项目根目录)';
        }
        moduleStatusBar.show();

        // Register Tree View
        vscode.window.registerTreeDataProvider('androidPanel', treeProvider);

        // Register Build Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('android.buildApk', async () => {
                await buildSystem.buildDebug();
            })
        );

        // ... [Existing Commands] ...

        // NEW: Select Module Command
        context.subscriptions.push(
            vscode.commands.registerCommand('android.selectModule', async () => {
                try {
                    const root = gradleService.findProjectRoot();
                    const modules = await gradleModuleService.getModules(root);
                    
                    if (modules.length === 0) {
                        vscode.window.showInformationMessage('在 settings.gradle 中未找到模块');
                        return;
                    }

                    const selected = await vscode.window.showQuickPick(modules, {
                        placeHolder: '选择要构建的 Gradle 模块',
                        title: '选择活动模块'
                    });

                    if (selected) {
                        // Save state
                        await context.workspaceState.update('android-studio-flash.selectedModule', selected);
                        
                        // Update Service
                        gradleService.setTargetModule(selected);
                        
                        // Update UI
                        moduleStatusBar.text = `$(package) Module: ${selected}`;
                        vscode.window.showInformationMessage(`活动模块: ${selected}`);
                        
                        // Refresh Tree to show checkmark
                        treeProvider.refresh();
                    }
                } catch (error: any) {
                    vscode.window.showErrorMessage(`选择模块失败: ${error.message}`);
                }
            })
        );

        // NEW: Select Module Directly from Tree
        context.subscriptions.push(
            vscode.commands.registerCommand('android.selectModuleFromTree', async (moduleName: string) => {
                if (moduleName) {
                    // Update Service
                    gradleService.setTargetModule(moduleName);
                    
                    // Save state
                    await context.workspaceState.update('android-studio-flash.selectedModule', moduleName);

                    // Update UI
                    moduleStatusBar.text = `模块: ${moduleName}`;
                    
                    // Refresh Tree to show checkmark
                    treeProvider.refresh();
                }
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.buildDebug', async () => {
                await buildSystem.buildDebug();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.buildRelease', async () => {
                await buildSystem.buildRelease();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.cleanProject', async () => {
                await buildSystem.cleanProject();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.syncGradle', async () => {
                await gradleService.syncGradle();
            })
        );

        // Signing Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('android.createKeystore', async () => {
                await keystoreManager.createKeystore();
            })
        );

        // Run Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('android.runApp', async () => {
                await buildSystem.runApp();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.debugApp', async () => {
                await buildSystem.debugApp();
            })
        );

        // Device Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('android.selectDevice', async () => {
                await deviceManager.selectDevice();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.selectDeviceFromTree', async (device) => {
                // Select device directly from Tree
                if (device) {
                    deviceManager.getDevices().forEach(d => {
                        if (d.id === device.id) {
                            deviceManager['selectedDevice'] = d;
                            deviceManager['onDidChangeDevicesEmitter'].fire();
                        }
                    });
                    statusBar.update();
                    treeProvider.refresh();
                    vscode.window.showInformationMessage(`已选择: ${device.id}`);
                }
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.refreshDevices', async () => {
                await deviceManager.refreshDevices();
                treeProvider.refresh();
                statusBar.update();
            })
        );

        // Logcat Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('android.showLogcat', async () => {
                await logcatManager.showLogcat();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.toggleLogcatFilter', async () => {
                await logcatManager.toggleFilterMode();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.stopLogcat', () => {
                logcatManager.stopLogcat();
                vscode.window.showInformationMessage('Logcat 已停止');
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.clearLogcat', () => {
                logcatManager.clearLogcat();
            })
        );

        // Wireless ADB Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('android.setupWireless', async () => {
                await wirelessManager.setupWirelessConnection();
                treeProvider.refresh();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.disconnectWireless', async (arg) => {
                let device: any = null;
                if (arg) {
                    if (arg.device) {
                        device = arg.device;
                    } else if (arg.id) {
                        device = arg;
                    }
                }
                
                if (device) {
                    await wirelessManager.disconnectDevice(device);
                    await deviceManager.refreshDevices();
                    treeProvider.refresh();
                } else {
                    vscode.window.showErrorMessage('无法识别要断开的设备。');
                }
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.refreshWireless', async () => {
                await wirelessManager.refreshWirelessDevices();
                treeProvider.refresh();
            })
        );

        // Diagnostics Command
        context.subscriptions.push(
            vscode.commands.registerCommand('android.runDiagnostics', async () => {
                const { runDiagnostics } = require('./utils/diagnostics');
                await runDiagnostics(context);
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.forgetWirelessDevice', async (arg) => {
                let deviceId: string | undefined;
                if (arg) {
                    if (arg.device && arg.device.id) {
                        deviceId = arg.device.id;
                    } else if (arg.id) {
                        deviceId = arg.id;
                    }
                }
                
                if (deviceId) {
                    await wirelessManager.removeSavedDevice(deviceId);
                    await deviceManager.refreshDevices();
                    treeProvider.refresh();
                } else {
                    vscode.window.showErrorMessage('无法识别要忘记的设备。');
                }
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.reconnectWirelessDevice', async (arg) => {
                let device: any = null;
                if (arg) {
                    if (arg.device) {
                        device = arg.device;
                    } else if (arg.ipAddress && arg.port) {
                        device = arg;
                    }
                }
                
                if (device && device.ipAddress && device.port) {
                    const endpoint = `${device.ipAddress}:${device.port}`;
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: `正在连接到 ${device.model || endpoint}...`,
                        cancellable: false
                    }, async () => {
                        const success = await wirelessManager.connectSavedDevice(device);
                        if (success) {
                            vscode.window.showInformationMessage(`已连接到 ${device.model || endpoint}`);
                        } else {
                            const choice = await vscode.window.showErrorMessage(
                                `连接到 ${device.model || endpoint} 失败。设备可能已离线或无线端口已更改。`,
                                '更改端口并重试',
                                '重新配对'
                            );
                            if (choice === '更改端口并重试') {
                                const newPortStr = await vscode.window.showInputBox({
                                    prompt: `输入 ${device.ipAddress} 的当前无线端口`,
                                    value: device.port ? String(device.port) : '5555',
                                    validateInput: (val) => {
                                        const p = parseInt(val);
                                        return (!p || p < 1 || p > 65535) ? '请输入有效的端口号 (1-65535)' : null;
                                    }
                                });
                                if (newPortStr) {
                                    const newPort = parseInt(newPortStr);
                                    const updatedDevice = {
                                        ...device,
                                        id: `${device.ipAddress}:${newPort}`,
                                        port: newPort
                                    };
                                    await wirelessManager.removeSavedDevice(device.id);
                                    await wirelessManager.addSavedDevice(updatedDevice);
                                    
                                    const retrySuccess = await wirelessManager.connectSavedDevice(updatedDevice);
                                    if (retrySuccess) {
                                        vscode.window.showInformationMessage(`已连接到 ${updatedDevice.model || `${updatedDevice.ipAddress}:${newPort}`}`);
                                    } else {
                                        vscode.window.showErrorMessage(`连接到 ${updatedDevice.ipAddress}:${newPort} 失败。`);
                                    }
                                }
                            } else if (choice === '重新配对') {
                                vscode.commands.executeCommand('android.setupWireless');
                            }
                        }
                        await deviceManager.refreshDevices();
                        treeProvider.refresh();
                    });
                } else {
                    vscode.window.showErrorMessage('设备配置无效，无法重新连接。');
                }
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.copyWirelessIp', async (arg) => {
                let ipAddress: string | undefined;
                if (arg) {
                    if (arg.device && arg.device.ipAddress) {
                        ipAddress = arg.device.ipAddress;
                    } else if (arg.ipAddress) {
                        ipAddress = arg.ipAddress;
                    } else if (arg.device && arg.device.id && arg.device.id.includes(':')) {
                        ipAddress = arg.device.id.split(':')[0];
                    } else if (arg.id && arg.id.includes(':')) {
                        ipAddress = arg.id.split(':')[0];
                    }
                }
                
                if (ipAddress) {
                    await vscode.env.clipboard.writeText(ipAddress);
                    vscode.window.showInformationMessage(`已复制 IP 地址到剪贴板: ${ipAddress}`);
                } else {
                    vscode.window.showErrorMessage('无法找到此设备的 IP 地址。');
                }
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.showDeviceInfo', async (arg) => {
                let device: any = null;
                if (arg) {
                    if (arg.device) {
                        device = arg.device;
                    } else {
                        device = arg;
                    }
                }
                
                if (!device) {
                    vscode.window.showErrorMessage('无法识别要显示信息的设备。');
                    return;
                }

                const isWireless = device.id.includes(':') || !!device.ipAddress;
                const isEmulator = device.id.startsWith('emulator-') || device.type === 'emulator';
                
                let connectionTypeLabel = 'USB 连接';
                if (isEmulator) {
                    connectionTypeLabel = 'Android 虚拟设备 (模拟器)';
                } else if (isWireless) {
                    const port = device.port || (device.id.includes(':') ? parseInt(device.id.split(':')[1]) : 5555);
                    connectionTypeLabel = port === 5555 ? '无线连接 (ADB over TCP/IP)' : '无线调试 (Android 11+)';
                }

                let ipAddress = device.ipAddress;
                let port = device.port;
                if (isWireless && (!ipAddress || !port)) {
                    const parts = device.id.split(':');
                    ipAddress = parts[0];
                    port = parseInt(parts[1]) || 5555;
                }

                const details = [
                    `设备信息: ${device.model || device.product || '未知'}`,
                    `型号: ${device.model || '未知'}`,
                    `产品: ${device.product || '未知'}`,
                    `设备 ID: ${device.id}`,
                    `连接类型: ${connectionTypeLabel}`,
                    `当前状态: ${device.state || '未知'}`
                ];

                if (isWireless && ipAddress) {
                    details.push(`IP 地址: ${ipAddress}`);
                    details.push(`ADB 端口: ${port}`);
                }

                vscode.window.showInformationMessage(
                    details[0] + '\n\n' + details.slice(1).join('\n'),
                    { modal: true }
                );
            })
        );

        // Initial device refresh
        // Auto-reconnect saved wireless devices
        await wirelessManager.autoReconnectSavedDevices();
        
        await deviceManager.refreshDevices();
        statusBar.update();

        // Welcome message
        vscode.window.showInformationMessage('Android Studio Flash 已就绪！');

    } catch (error) {
        vscode.window.showErrorMessage(`扩展初始化错误: ${error}`);
        console.error('Activation error:', error);
    }
}

export function deactivate() {
    console.log('Android Studio Flash 正在停用...');
    
    if (logcatManager) {
        logcatManager.dispose();
    }
    
    if (statusBar) {
        statusBar.dispose();
    }
    
    if (wirelessManager) {
        wirelessManager.dispose();
    }
}
