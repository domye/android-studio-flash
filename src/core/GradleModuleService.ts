import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 解析 settings.gradle 获取项目模块列表。
 */
export class GradleModuleService {

    /**
     * 从 settings.gradle 中提取所有 included 模块
     * @param projectRoot Android 项目根目录
     */
    async getModules(projectRoot: string): Promise<string[]> {
        const settingsPath = this.getSettingsGradlePath(projectRoot);
        if (!settingsPath) {
            return [];
        }

        try {
            const content = fs.readFileSync(settingsPath, 'utf8');
            return this.parseModules(content);
        } catch (error) {
            console.error('Failed to parse settings.gradle:', error);
            return [];
        }
    }

    /**
     * 查找 settings.gradle 或 settings.gradle.kts
     */
    private getSettingsGradlePath(projectRoot: string): string | null {
        const groovyPath = path.join(projectRoot, 'settings.gradle');
        const ktsPath = path.join(projectRoot, 'settings.gradle.kts');

        if (fs.existsSync(groovyPath)) return groovyPath;
        if (fs.existsSync(ktsPath)) return ktsPath;
        return null;
    }

    /**
     * 使用正则提取模块名。
     * 支持 include ':app'、include(":app")、include ':app', ':lib' 等格式
     */
    private parseModules(content: string): string[] {
        const modules: string[] = ['(项目根目录)'];

        const regex = /['"](:[^'"]+)['"]/g;

        let match;
        while ((match = regex.exec(content)) !== null) {
            const moduleName = match[1];
            if (moduleName.startsWith(':') && !modules.includes(moduleName)) {
                modules.push(moduleName);
            }
        }

        return modules.sort();
    }
}
