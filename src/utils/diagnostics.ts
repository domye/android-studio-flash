import * as vscode from 'vscode';
import { AndroidSDKManager } from '../core/AndroidSDKManager';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * 诊断工具，测试 ADB 连接和设备状态。
 * 帮助用户排查常见设置问题。
 */
export async function runDiagnostics(context: vscode.ExtensionContext): Promise<void> {
    const outputChannel = vscode.window.createOutputChannel('Android Diagnostics');
    outputChannel.show();

    outputChannel.appendLine('正在运行 Android 诊断...\n');
    outputChannel.appendLine('='.repeat(60));

    // 1. 检查 SDK
    outputChannel.appendLine('\n[检查 Android SDK]');
    const sdkManager = new AndroidSDKManager();
    const sdkPath = sdkManager.getSDKPath();

    if (sdkPath) {
        outputChannel.appendLine(`  SDK 路径: ${sdkPath}`);
    } else {
        outputChannel.appendLine('  未检测到 Android SDK！');
        outputChannel.appendLine('\n解决方案:');
        outputChannel.appendLine('  1. 在设置 -> android.sdkPath 中手动设置路径');
        outputChannel.appendLine('  2. 或设置 ANDROID_HOME 环境变量');
        return;
    }

    // 2. 检查 ADB
    outputChannel.appendLine('\n[检查 ADB]');
    try {
        const adbPath = sdkManager.getADBPath();
        outputChannel.appendLine(`  ADB 路径: ${adbPath}`);

        const { stdout: versionOutput } = await execAsync(`"${adbPath}" version`);
        const versionMatch = versionOutput.match(/Android Debug Bridge version ([\d.]+)/);
        if (versionMatch) {
            outputChannel.appendLine(`  ADB 版本: ${versionMatch[1]}`);
        }

    } catch (error: any) {
        outputChannel.appendLine(`  ADB 错误: ${error.message}`);
        outputChannel.appendLine('\n解决方案:');
        outputChannel.appendLine('  1. 打开 Android Studio -> SDK Manager');
        outputChannel.appendLine('  2. SDK Tools 选项卡 -> 启用 "Android SDK Platform-Tools"');
        return;
    }

    // 3. 检查 ADB Server
    outputChannel.appendLine('\n[检查 ADB 服务]');
    try {
        const adbPath = sdkManager.getADBPath();

        outputChannel.appendLine('  正在重启 ADB 服务...');
        await execAsync(`"${adbPath}" kill-server`);
        await execAsync(`"${adbPath}" start-server`);
        outputChannel.appendLine('  ADB 服务运行中');

    } catch (error: any) {
        outputChannel.appendLine(`  服务警告: ${error.message}`);
    }

    // 4. 检查已连接设备
    outputChannel.appendLine('\n[检查已连接设备]');
    try {
        const adbPath = sdkManager.getADBPath();
        const { stdout } = await execAsync(`"${adbPath}" devices -l`);

        const lines = stdout.split('\n').filter(l =>
            l.trim() && !l.startsWith('List of devices')
        );

        if (lines.length === 0) {
            outputChannel.appendLine('  没有已连接的设备！');
            outputChannel.appendLine('\n检查项:');
            outputChannel.appendLine('  1. 使用支持数据传输的 USB 线连接设备');
            outputChannel.appendLine('  2. 设备上已启用 USB 调试');
            outputChannel.appendLine('     设置 -> 开发者选项 -> USB 调试');
            outputChannel.appendLine('  3. 在弹出的"允许 USB 调试"提示上点击确认');
            outputChannel.appendLine('  4. 尝试换一根 USB 线或 USB 端口');
        } else {
            outputChannel.appendLine(`  发现设备: ${lines.length}\n`);

            lines.forEach((line, index) => {
                const parts = line.split(/\s+/);
                const deviceId = parts[0];
                const state = parts[1];

                outputChannel.appendLine(`  设备 ${index + 1}:`);
                outputChannel.appendLine(`    ID: ${deviceId}`);
                outputChannel.appendLine(`    状态: ${state}`);

                const modelMatch = line.match(/model:([^\s]+)/);
                const productMatch = line.match(/product:([^\s]+)/);

                if (modelMatch) {
                    outputChannel.appendLine(`    型号: ${modelMatch[1].replace(/_/g, ' ')}`);
                }
                if (productMatch) {
                    outputChannel.appendLine(`    产品: ${productMatch[1]}`);
                }

                if (state === 'unauthorized') {
                    outputChannel.appendLine('    [警告] 未授权！请在设备上确认 USB 调试提示');
                } else if (state === 'offline') {
                    outputChannel.appendLine('    [警告] 离线！尝试: adb kill-server && adb start-server');
                } else if (state === 'device') {
                    outputChannel.appendLine('    [正常] 可以正常使用');
                }

                outputChannel.appendLine('');
            });
        }

    } catch (error: any) {
        outputChannel.appendLine(`  检查设备失败: ${error.message}`);
    }

    // 5. 附加信息
    outputChannel.appendLine('\n' + '='.repeat(60));
    outputChannel.appendLine('\n其他资源:');
    outputChannel.appendLine('  故障排除指南: TROUBLESHOOTING.md');
    outputChannel.appendLine('  无线调试指南: WIRELESS_GUIDE.md');

    outputChannel.appendLine('\n诊断完成');
}
