import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface FriendlyDeviceInfo {
    manufacturer: string;
    marketName?: string;
    model: string;
}

// In-memory cache for device brand details to prevent redundant adb shell invocations
const deviceInfoCache = new Map<string, FriendlyDeviceInfo>();

/**
 * Clears the device info cache for a specific device or all devices.
 */
export function clearDeviceInfoCache(deviceId?: string): void {
    if (deviceId) {
        deviceInfoCache.delete(deviceId);
    } else {
        deviceInfoCache.clear();
    }
}

/**
 * Formats a manufacturer string with clean capitalization.
 */
function formatManufacturer(raw: string): string {
    if (!raw) return '';
    const trimmed = raw.trim();
    if (!trimmed) return '';
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

/**
 * Fetches detailed friendly brand, manufacturer, and marketing name for a physical Android device.
 * Uses bulletproof marker-based delimiter extraction to prevent misalignment when optional properties
 * (like ro.product.marketname on Pixel/Samsung devices) are empty.
 * 
 * @param adbPath Path to the ADB executable
 * @param deviceId The ID/Serial of the target device
 * @param fallbackModel The fallback model name to use if getprop fails or properties are missing
 * @returns An object containing the manufacturer, marketName (if found), and the formatted friendly model name.
 */
export async function fetchFriendlyDeviceInfo(
    adbPath: string,
    deviceId: string,
    fallbackModel: string = ''
): Promise<FriendlyDeviceInfo> {
    if (deviceInfoCache.has(deviceId)) {
        return deviceInfoCache.get(deviceId)!;
    }

    try {
        // Use standard echo markers so missing/empty properties preserve their slots reliably
        const shellCommand = `"${adbPath}" -s "${deviceId}" shell "echo __MFG__; getprop ro.product.manufacturer; echo __MKT__; getprop ro.product.marketname; echo __MDL__; getprop ro.product.model"`;
        const { stdout: details } = await execAsync(shellCommand, { timeout: 3000 });
        
        const mfgMatch = details.match(/__MFG__\r?\n([\s\S]*?)(?=__MKT__|$)/);
        const mktMatch = details.match(/__MKT__\r?\n([\s\S]*?)(?=__MDL__|$)/);
        const mdlMatch = details.match(/__MDL__\r?\n([\s\S]*?)$/);

        const rawManufacturer = mfgMatch ? mfgMatch[1].trim() : '';
        const manufacturer = formatManufacturer(rawManufacturer);
        const marketName = mktMatch && mktMatch[1].trim() ? mktMatch[1].trim() : undefined;
        const rawModel = mdlMatch && mdlMatch[1].trim() ? mdlMatch[1].trim() : fallbackModel;

        let model = fallbackModel || 'Unknown Device';
        if (marketName) {
            model = manufacturer ? `${manufacturer} ${marketName}` : marketName;
        } else if (rawModel) {
            const cleanModel = rawModel.replace(/_/g, ' ');
            if (manufacturer && !cleanModel.toLowerCase().startsWith(manufacturer.toLowerCase())) {
                model = `${manufacturer} ${cleanModel}`;
            } else {
                model = cleanModel;
            }
        }

        const result: FriendlyDeviceInfo = {
            manufacturer: manufacturer || 'Unknown',
            marketName,
            model
        };

        deviceInfoCache.set(deviceId, result);
        return result;
    } catch (e) {
        console.error(`Failed to fetch friendly brand info for device ${deviceId}:`, e);
    }
    
    return {
        manufacturer: 'Unknown',
        model: fallbackModel || 'Unknown Device'
    };
}
