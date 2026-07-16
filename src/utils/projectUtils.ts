import * as path from 'path';
import * as fs from 'fs';

/**
 * 查找 Android 项目根目录。
 * 在当前工作区和直接子目录中搜索 settings.gradle 或 build.gradle + gradlew。
 */
export function findProjectRoot(workspaceRoot: string): string {
    if (isProjectRoot(workspaceRoot)) {
        return workspaceRoot;
    }

    try {
        const subdirs = fs.readdirSync(workspaceRoot)
            .map(name => path.join(workspaceRoot, name))
            .filter(dir => fs.statSync(dir).isDirectory());
        for (const dir of subdirs) {
            if (isProjectRoot(dir)) {
                return dir;
            }
        }
    } catch { /* ignore */ }

    return workspaceRoot;
}

/**
 * 判断目录是否为 Gradle 项目根
 */
export function isProjectRoot(dirPath: string): boolean {
    const hasSettings = fs.existsSync(path.join(dirPath, 'settings.gradle')) ||
                       fs.existsSync(path.join(dirPath, 'settings.gradle.kts'));
    const hasBuild = fs.existsSync(path.join(dirPath, 'build.gradle')) ||
                    fs.existsSync(path.join(dirPath, 'build.gradle.kts'));
    const hasWrapper = fs.existsSync(path.join(dirPath, 'gradlew')) ||
                      fs.existsSync(path.join(dirPath, 'gradlew.bat'));
    return (hasSettings || hasBuild) && hasWrapper;
}

/**
 * 快速检查工作区是否为 Android 项目。
 * 比 isProjectRoot 更宽松，用于激活加速。
 */
export function isAndroidWorkspace(rootPath: string): boolean {
    const hasSettings = fs.existsSync(path.join(rootPath, 'settings.gradle')) ||
                        fs.existsSync(path.join(rootPath, 'settings.gradle.kts'));
    const hasWrapper = fs.existsSync(path.join(rootPath, 'gradlew')) ||
                       fs.existsSync(path.join(rootPath, 'gradlew.bat'));
    const hasAppBuild = fs.existsSync(path.join(rootPath, 'app', 'build.gradle')) ||
                        fs.existsSync(path.join(rootPath, 'app', 'build.gradle.kts'));

    if (hasSettings || hasWrapper || hasAppBuild) {
        return true;
    }

    try {
        const subdirs = fs.readdirSync(rootPath)
            .map(n => path.join(rootPath, n))
            .filter(d => fs.statSync(d).isDirectory());
        return subdirs.some(dir =>
            fs.existsSync(path.join(dir, 'settings.gradle')) ||
            fs.existsSync(path.join(dir, 'settings.gradle.kts')) ||
            fs.existsSync(path.join(dir, 'gradlew')) ||
            fs.existsSync(path.join(dir, 'gradlew.bat'))
        );
    } catch {
        return false;
    }
}
