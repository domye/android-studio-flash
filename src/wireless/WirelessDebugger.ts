import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export type PairingMethod = 'pairing-code' | 'qr-code';

/**
 * 处理 Android 11+ 设备的无线调试配对。
 */
export class WirelessDebugger {
    constructor(private adbPath: string) {}

    /**
     * 选择配对方式
     */
    async promptPairingMethod(): Promise<PairingMethod | null> {
        const items = [
            {
                label: '配对码',
                description: '使用 6 位配对码',
                detail: '设置 -> 开发者选项 -> 无线调试 -> 使用配对码配对设备',
                method: 'pairing-code' as const
            },
            {
                label: '二维码',
                description: '扫描二维码（即将支持）',
                detail: '设置 -> 开发者选项 -> 无线调试 -> 使用二维码配对设备',
                method: 'qr-code' as const
            }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '请选择配对方式？'
        });

        return selected?.method || null;
    }

    /**
     * 使用配对码进行配对
     */
    async pairWithCode(): Promise<void> {
        const confirmed = await vscode.window.showInformationMessage(
            '在设备上操作：\n' +
            '1. 打开 设置 -> 开发者选项 -> 无线调试\n' +
            '2. 开启无线调试\n' +
            '3. 点击 "使用配对码配对设备"\n' +
            '4. 保持屏幕常亮',
            '准备好了',
            '取消'
        );

        if (confirmed !== '准备好了') {
            return;
        }

        const ipPort = await vscode.window.showInputBox({
            prompt: '输入 IP 地址:端口（例如 192.168.1.100:45678）',
            placeHolder: '192.168.1.100:45678',
            validateInput: (value) => {
                const regex = /^(\d{1,3}\.){3}\d{1,3}:\d+$/;
                return regex.test(value) ? null : '格式错误。请使用: IP:端口';
            }
        });

        if (!ipPort) {
            return;
        }

        const pairingCode = await vscode.window.showInputBox({
            prompt: '输入 6 位配对码',
            placeHolder: '123456',
            validateInput: (value) => {
                return /^\d{6}$/.test(value) ? null : '必须为 6 位数字';
            }
        });

        if (!pairingCode) {
            return;
        }

        await this.executePairing(ipPort, pairingCode);
    }

    /**
     * 执行配对操作
     */
    private async executePairing(ipPort: string, pairingCode: string): Promise<void> {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '正在配对...',
                cancellable: false
            }, async () => {
                const { stdout, stderr } = await execAsync(
                    `"${this.adbPath}" pair ${ipPort} ${pairingCode}`
                );

                console.log('Pairing output:', stdout);

                if (stderr && stderr.includes('failed')) {
                    throw new Error(stderr);
                }
            });

            await this.connectAfterPairing(ipPort.split(':')[0]);

        } catch (error: any) {
            vscode.window.showErrorMessage(
                `配对失败: ${error.message}\n\n` +
                '请确保：\n' +
                '  - 设备和电脑在同一个网络中\n' +
                '  - 配对码输入正确\n' +
                '  - IP:端口输入正确'
            );
        }
    }

    /**
     * 配对成功后连接设备
     */
    private async connectAfterPairing(deviceIp: string): Promise<void> {
        const port = await vscode.window.showInputBox({
            prompt: '在设备上返回无线调试主界面\n' +
                    '输入 "设备名称" 下方显示的端口号（例如 37843）',
            placeHolder: '37843',
            validateInput: (value) => {
                return /^\d+$/.test(value) ? null : '必须为数字';
            }
        });

        if (!port) {
            return;
        }

        const endpoint = `${deviceIp}:${port}`;

        try {
            await execAsync(`"${this.adbPath}" connect ${endpoint}`);

            vscode.window.showInformationMessage(
                `连接成功！\n${endpoint}\n\n` +
                '现在可以断开 USB 数据线（如果已连接）'
            );

            vscode.commands.executeCommand('android.refreshDevices');

        } catch (error: any) {
            vscode.window.showErrorMessage(`连接失败: ${error.message}`);
        }
    }
}
