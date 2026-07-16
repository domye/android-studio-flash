import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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
import { runDiagnostics } from './utils/diagnostics';

/**
 * 快速检查工作区是否为 Android 项目。
 * 避免在无关项目（如有 build.gradle 的 npm 包）中激活。
 */
function isAndroidWorkspace(rootPath: string): boolean {
    const hasSettings = fs.existsSync(path.join(rootPath, 'settings.gradle')) ||
                        fs.existsSync(path.join(rootPath, 'settings.gradle.kts'));
    const hasWrapper = fs.existsSync(path.join(rootPath, 'gradlew')) ||
                       fs.existsSync(path.join(rootPath, 'gradlew.bat'));
    const hasAppBuild = fs.existsSync(path.join(rootPath, 'app', 'build.gradle')) ||
                        fs.existsSync(path.join(rootPath, 'app', 'build.gradle.kts'));

    if (hasSettings || hasWrapper || hasAppBuild) {
        return true;
    }

    // 检查一级子目录（兼容 android/ 子目录结构，如 Flutter 项目）
    try {
        const subdirs = fs.readdirSync(rootPath)
            .map((n: string) => path.join(rootPath, n))
            .filter((d: string) => fs.statSync(d).isDirectory());
        return subdirs.some((dir: string) =>
            fs.existsSync(path.join(dir, 'settings.gradle')) ||
            fs.existsSync(path.join(dir, 'settings.gradle.kts')) ||
            fs.existsSync(path.join(dir, 'gradlew')) ||
            fs.existsSync(path.join(dir, 'gradlew.bat'))
        );
    } catch {
        return false;
    }
}

let deviceManager: DeviceManager;
let buildSystem: BuildSystem;
let statusBar: BuildStatusBar;
let logcatManager: LogcatManager;
let treeProvider: AndroidTreeProvider;
let wirelessManager: WirelessADBManager;

export async function activate(context: vscode.ExtensionContext) {
    // 提前退出：仅对 Android 项目激活
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder || !isAndroidWorkspace(workspaceFolder.uri.fsPath)) {
        console.log('Not an Android project, skipping activation');
        return;
    }

    console.log('Android Studio Flash is now active!');

    try {
        const sdkManager = new AndroidSDKManager();
        const gradleService = new GradleService(sdkManager);
        const gradleModuleService = new GradleModuleService();
        deviceManager = new DeviceManager();
        statusBar = new BuildStatusBar(deviceManager);
        buildSystem = new BuildSystem(gradleService, deviceManager, statusBar);
        logcatManager = new LogcatManager(deviceManager, sdkManager);
        wirelessManager = new WirelessADBManager(sdkManager.getADBPath(), context);

        const keystoreManager = new KeystoreManager(context);
        const signingWizard = new SigningWizard(keystoreManager);
        buildSystem.setSigningWizard(signingWizard);

        treeProvider = new AndroidTreeProvider(
            deviceManager,
            buildSystem,
            logcatManager,
            wirelessManager,
            gradleService,
            gradleModuleService
        );

        // 模块选择状态栏
        const moduleStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        moduleStatusBar.command = 'android.selectModule';
        context.subscriptions.push(moduleStatusBar);

        const savedModule = context.workspaceState.get<string>('android-studio-flash.selectedModule');
        if (savedModule) {
            gradleService.setTargetModule(savedModule);
            moduleStatusBar.text = `模块: ${savedModule}`;
        } else {
            moduleStatusBar.text = '模块: (项目根目录)';
        }
        moduleStatusBar.show();

        vscode.window.registerTreeDataProvider('androidPanel', treeProvider);

        context.subscriptions.push(
            vscode.commands.registerCommand('android.buildApk', async () => {
                await buildSystem.buildDebug();
            })
        );

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
                        await context.workspaceState.update('android-studio-flash.selectedModule', selected);
                        gradleService.setTargetModule(selected);
                        moduleStatusBar.text = `模块: ${selected}`;
                        vscode.window.showInformationMessage(`活动模块: ${selected}`);
                        treeProvider.refresh();
                    }
                } catch (error: any) {
                    vscode.window.showErrorMessage(`选择模块失败: ${error.message}`);
                }
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.selectModuleFromTree', async (moduleName: string) => {
                if (moduleName) {
                    gradleService.setTargetModule(moduleName);
                    await context.workspaceState.update('android-studio-flash.selectedModule', moduleName);
                    moduleStatusBar.text = `模块: ${moduleName}`;
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

        context.subscriptions.push(
            vscode.commands.registerCommand('android.createKeystore', async () => {
                await keystoreManager.createKeystore();
            })
        );

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

        context.subscriptions.push(
            vscode.commands.registerCommand('android.selectDevice', async () => {
                await deviceManager.selectDevice();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.selectDeviceFromTree', async (device) => {
                if (device) {
                    deviceManager.selectDeviceById(device.id);
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

        context.subscriptions.push(
            vscode.commands.registerCommand('android.setupWireless', async () => {
                await wirelessManager.setupWirelessConnection();
                treeProvider.refresh();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.disconnectWireless', async (device) => {
                if (device) {
                    await wirelessManager.disconnectDevice(device);
                    treeProvider.refresh();
                }
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.refreshWireless', async () => {
                await wirelessManager.refreshWirelessDevices();
                treeProvider.refresh();
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.runDiagnostics', async () => {
                await runDiagnostics(context);
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.forgetWirelessDevice', async (device) => {
                if (device && device.id) {
                    await wirelessManager.removeSavedDevice(device.id);
                    await deviceManager.refreshDevices();
                    treeProvider.refresh();
                }
            })
        );

        context.subscriptions.push(
            vscode.commands.registerCommand('android.reconnectWirelessDevice', async (device) => {
                if (device && device.ipAddress && device.port) {
                    const endpoint = `${device.ipAddress}:${device.port}`;
                    vscode.window.showInformationMessage(`正在重新连接到 ${endpoint}...`);
                    await wirelessManager.autoReconnectSavedDevices();
                    await deviceManager.refreshDevices();
                    treeProvider.refresh();
                }
            })
        );

        await wirelessManager.autoReconnectSavedDevices();

        await deviceManager.refreshDevices();
        statusBar.update();

        vscode.window.showInformationMessage('Android Studio Flash 已就绪！');

    } catch (error) {
        vscode.window.showErrorMessage(`扩展初始化错误: ${error}`);
        console.error('Activation error:', error);
    }
}

export function deactivate() {
    console.log('Android Studio Flash is deactivating...');

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
