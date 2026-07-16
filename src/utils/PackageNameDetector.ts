import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * 包名检测结果，包含来源和可信度
 */
export interface PackageDetectionResult {
    packageName: string;
    source: 'apk' | 'foreground' | 'gradle' | 'manifest' | 'device';
    confidence: 'high' | 'medium' | 'low';
}

/**
 * 智能包名检测器，从多个来源获取包名。
 * 优先级：已构建 APK > build.gradle > 前台应用 > 已安装应用。
 */
export class PackageNameDetector {
    /**
     * 智能检测：按优先级依次尝试所有方法
     */
    static async detectPackageNameSmart(
        adbPath?: string,
        deviceId?: string,
        gradlePath?: string
    ): Promise<PackageDetectionResult[]> {
        const results: PackageDetectionResult[] = [];

        // 优先级 1：从已构建 APK 获取（最准确）
        if (gradlePath) {
            const apkPackage = await this.getPackageFromBuiltApk(gradlePath);
            if (apkPackage) {
                results.push({
                    packageName: apkPackage,
                    source: 'apk',
                    confidence: 'high'
                });
            }
        }

        // 优先级 2：从 build.gradle 获取
        const gradlePackage = await this.detectPackageName();
        if (gradlePackage) {
            results.push({
                packageName: gradlePackage,
                source: 'gradle',
                confidence: 'high'
            });
        }

        // 优先级 3：从设备前台应用获取
        if (adbPath && deviceId) {
            const foregroundPackage = await this.getForegroundPackage(adbPath, deviceId);
            if (foregroundPackage) {
                if (!results.find(r => r.packageName === foregroundPackage)) {
                    results.push({
                        packageName: foregroundPackage,
                        source: 'foreground',
                        confidence: 'medium'
                    });
                }
            }
        }

        // 优先级 4：搜索设备上匹配的包名
        if (adbPath && deviceId && gradlePackage) {
            const devicePackages = await this.findMatchingPackageOnDevice(
                adbPath,
                deviceId,
                gradlePackage
            );

            devicePackages.forEach(pkg => {
                if (!results.find(r => r.packageName === pkg)) {
                    results.push({
                        packageName: pkg,
                        source: 'device',
                        confidence: 'medium'
                    });
                }
            });
        }

        return results;
    }

    /**
     * 从已构建的 APK 获取包名（最准确）
     */
    static async getPackageFromBuiltApk(projectRoot: string): Promise<string | null> {
        try {
            const apkPaths = [
                path.join(projectRoot, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
                path.join(projectRoot, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
                path.join(projectRoot, 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
            ];

            console.log('Searching for built APK...');

            for (const apkPath of apkPaths) {
                console.log(`  Checking: ${apkPath}`);

                if (fs.existsSync(apkPath)) {
                    console.log(`Found APK: ${apkPath}`);
                    const packageName = await this.extractPackageFromApk(apkPath);

                    if (packageName) {
                        console.log(`Package from built APK (${path.basename(apkPath)}): ${packageName}`);
                        return packageName;
                    } else {
                        console.log(`Failed to extract package from ${path.basename(apkPath)}`);
                    }
                } else {
                    console.log(`  Not found`);
                }
            }

            console.log('No built APK found. Build the project first!');
        } catch (error) {
            console.error('Error getting package from built APK:', error);
        }

        return null;
    }

    /**
     * 使用 aapt 从 APK 中提取包名
     */
    private static async extractPackageFromApk(apkPath: string): Promise<string | null> {
        try {
            const sdkPath = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;

            if (sdkPath) {
                const buildToolsPath = path.join(sdkPath, 'build-tools');

                if (fs.existsSync(buildToolsPath)) {
                    const buildToolVersions = fs.readdirSync(buildToolsPath).sort().reverse();

                    for (const version of buildToolVersions) {
                        const aaptExe = process.platform === 'win32' ? 'aapt.exe' : 'aapt';
                        const aaptPath = path.join(buildToolsPath, version, aaptExe);

                        if (fs.existsSync(aaptPath)) {
                            console.log(`Found aapt: ${aaptPath}`);

                            try {
                                const { stdout } = await execAsync(`"${aaptPath}" dump badging "${apkPath}"`);
                                const match = stdout.match(/package:\s*name='([^']+)'/);

                                if (match && match[1]) {
                                    console.log(`Extracted package: ${match[1]}`);
                                    return match[1];
                                }
                            } catch (error: any) {
                                console.log(`aapt failed: ${error.message}`);
                            }

                            break;
                        }
                    }
                }
            }

            // 备选：从 PATH 中查找 aapt
            try {
                const { stdout } = await execAsync(`aapt dump badging "${apkPath}"`);
                const match = stdout.match(/package:\s*name='([^']+)'/);

                if (match && match[1]) {
                    console.log('Extracted package using aapt from PATH');
                    return match[1];
                }
            } catch (error) {
                // aapt 不在 PATH 中
            }

            console.log('Tip: aapt not found. Install Android SDK build-tools');

        } catch (error) {
            console.error('Error extracting package from APK:', error);
        }

        return null;
    }

    /**
     * 获取前台应用的包名
     */
    static async getForegroundPackage(adbPath: string, deviceId: string): Promise<string | null> {
        try {
            const { stdout } = await execAsync(
                `"${adbPath}" -s ${deviceId} shell "dumpsys window | grep mCurrentFocus"`
            );

            const match = stdout.match(/mCurrentFocus=Window\{[^}]*\s+u\d+\s+([^\s\/]+)/);
            if (match && match[1]) {
                console.log(`Foreground package: ${match[1]}`);
                return match[1];
            }

            const { stdout: activityOut } = await execAsync(
                `"${adbPath}" -s ${deviceId} shell "dumpsys activity activities | grep mResumedActivity"`
            );

            const activityMatch = activityOut.match(/u\d+\s+([^\s\/]+)/);
            if (activityMatch && activityMatch[1]) {
                console.log(`Foreground package (from activity): ${activityMatch[1]}`);
                return activityMatch[1];
            }

        } catch (error) {
            console.error('Error getting foreground package:', error);
        }

        return null;
    }

    /**
     * 查找 Android 项目根目录（与 GradleService.findProjectRoot 对应）
     */
    private static findProjectRoot(): string | null {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return null;

        const rootPath = workspaceFolder.uri.fsPath;

        const isRoot = (dir: string): boolean => {
            const hasSettings = fs.existsSync(path.join(dir, 'settings.gradle')) ||
                               fs.existsSync(path.join(dir, 'settings.gradle.kts'));
            const hasBuild = fs.existsSync(path.join(dir, 'build.gradle')) ||
                            fs.existsSync(path.join(dir, 'build.gradle.kts'));
            const hasWrapper = fs.existsSync(path.join(dir, 'gradlew')) ||
                              fs.existsSync(path.join(dir, 'gradlew.bat'));
            return (hasSettings || hasBuild) && hasWrapper;
        };

        if (isRoot(rootPath)) return rootPath;

        try {
            const subdirs = fs.readdirSync(rootPath)
                .map(name => path.join(rootPath, name))
                .filter(dir => fs.statSync(dir).isDirectory());

            for (const dir of subdirs) {
                if (isRoot(dir)) return dir;
            }
        } catch { /* ignore */ }

        return rootPath;
    }

    /**
     * 从项目中提取包名（支持构建变体）
     */
    static async detectPackageName(): Promise<string | null> {
        const projectRoot = this.findProjectRoot();
        if (!projectRoot) {
            return null;
        }

        const packageFromGradle = await this.extractFromBuildGradle(projectRoot);
        if (packageFromGradle) {
            return packageFromGradle;
        }

        const packageFromManifest = await this.extractFromManifest(projectRoot);
        if (packageFromManifest) {
            return packageFromManifest;
        }

        return null;
    }

    /**
     * 从 build.gradle 提取包名（支持构建变体）
     */
    private static async extractFromBuildGradle(projectRoot: string): Promise<string | null> {
        const buildGradlePaths = [
            path.join(projectRoot, 'app', 'build.gradle'),
            path.join(projectRoot, 'app', 'build.gradle.kts'),
            path.join(projectRoot, 'build.gradle'),
            path.join(projectRoot, 'build.gradle.kts')
        ];

        for (const gradlePath of buildGradlePaths) {
            if (fs.existsSync(gradlePath)) {
                try {
                    const content = fs.readFileSync(gradlePath, 'utf-8');

                    const basePackageMatch = content.match(/applicationId\s+["']([^"']+)["']/);
                    const namespaceMatch = content.match(/namespace\s*=\s*["']([^"']+)["']/);

                    const basePackage = basePackageMatch?.[1] || namespaceMatch?.[1];

                    if (basePackage) {
                        const debugSuffixMatch = content.match(/debug\s*{[^}]*applicationIdSuffix\s+["']([^"']+)["']/s);

                        if (debugSuffixMatch && debugSuffixMatch[1]) {
                            const debugPackage = basePackage + debugSuffixMatch[1];
                            console.log(`Found debug package: ${debugPackage} (base: ${basePackage})`);
                            return debugPackage;
                        }

                        console.log(`Package name found: ${basePackage}`);
                        return basePackage;
                    }
                } catch (error) {
                    console.error(`Error reading ${gradlePath}:`, error);
                }
            }
        }

        return null;
    }

    /**
     * 从 AndroidManifest.xml 提取包名
     */
    private static async extractFromManifest(projectRoot: string): Promise<string | null> {
        const manifestPaths = [
            path.join(projectRoot, 'app', 'src', 'main', 'AndroidManifest.xml'),
            path.join(projectRoot, 'src', 'main', 'AndroidManifest.xml'),
            path.join(projectRoot, 'AndroidManifest.xml')
        ];

        for (const manifestPath of manifestPaths) {
            if (fs.existsSync(manifestPath)) {
                try {
                    const content = fs.readFileSync(manifestPath, 'utf-8');

                    const match = content.match(/package\s*=\s*["']([^"']+)["']/);
                    if (match && match[1]) {
                        console.log(`Package name found in manifest: ${match[1]}`);
                        return match[1];
                    }
                } catch (error) {
                    console.error(`Error reading ${manifestPath}:`, error);
                }
            }
        }

        return null;
    }

    /**
     * 从 APK 获取包名（公开包装器）
     */
    static async getPackageFromApk(apkPath: string): Promise<string | null> {
        return await this.extractPackageFromApk(apkPath);
    }

    /**
     * 获取设备上已安装的包名列表
     */
    static async getInstalledPackages(adbPath: string, deviceId: string): Promise<string[]> {
        try {
            const { stdout } = await execAsync(`"${adbPath}" -s ${deviceId} shell pm list packages`);

            const packages = stdout
                .split('\n')
                .filter(line => line.startsWith('package:'))
                .map(line => line.replace('package:', '').trim())
                .filter(pkg => pkg.length > 0);

            return packages;
        } catch (error) {
            console.error('Error getting installed packages:', error);
            return [];
        }
    }

    /**
     * 在设备上查找匹配的包名
     */
    static async findMatchingPackageOnDevice(
        adbPath: string,
        deviceId: string,
        basePackage: string
    ): Promise<string[]> {
        const allPackages = await this.getInstalledPackages(adbPath, deviceId);

        const matches = allPackages.filter(pkg => pkg.startsWith(basePackage));

        return matches;
    }

    /**
     * 显示包名选择对话框（按可信度排序）
     */
    static async promptForPackageName(
        detectionResults: PackageDetectionResult[]
    ): Promise<string | null> {
        const items: any[] = [];

        const sortedResults = detectionResults.sort((a, b) => {
            const confidenceOrder = { high: 0, medium: 1, low: 2 };
            return confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
        });

        sortedResults.forEach((result, index) => {
            const sourceNames = {
                apk: 'From built APK (100% accurate)',
                foreground: 'Currently foreground app',
                gradle: 'From build.gradle',
                manifest: 'From AndroidManifest.xml',
                device: 'Installed on device'
            };

            items.push({
                label: `${result.packageName}`,
                description: sourceNames[result.source],
                packageName: result.packageName,
                picked: index === 0,
                detail: result.confidence === 'high' ? 'Recommended' : ''
            });
        });

        const uniqueItems = items.filter((item, index, self) =>
            index === self.findIndex(t => t.packageName === item.packageName)
        );

        uniqueItems.push({
            label: '-'.repeat(50),
            kind: vscode.QuickPickItemKind.Separator
        });

        uniqueItems.push({
            label: 'Enter Package Name manually',
            description: 'For custom input',
            packageName: null
        });

        const selected = await vscode.window.showQuickPick(uniqueItems, {
            placeHolder: 'Select Package Name (sorted by accuracy)'
        });

        if (!selected || selected.kind === vscode.QuickPickItemKind.Separator) {
            return null;
        }

        if (selected.packageName) {
            return selected.packageName;
        }

        const input = await vscode.window.showInputBox({
            prompt: '输入应用包名',
            placeHolder: 'com.example.app'
        });

        return input || null;
    }
}
