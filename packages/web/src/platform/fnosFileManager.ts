import { TrimApp } from "@trimjs/web-app";

let sdk: TrimApp | undefined;

export async function openFnOSFileManager(
  path: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    sdk ??= new TrimApp();
    await sdk.ready();
    // 普通浏览器没有 NAS 宿主；不能把 SDK 的空操作当成已打开目录。
    if (sdk.isStandaloneWeb) {
      return { success: false, error: "Opening directories requires the fnOS app host" };
    }
    await sdk.openFileManager(path);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
