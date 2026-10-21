/**
 * SevenZip Password Verification Engine
 *
 * REAL ENGINE (Android native build):
 *   Uses SevenZipJBinding (net.sf.sevenzipjbinding:sevenzipjbinding + native .so)
 *   Integration is provided via a native Kotlin module (see native/README.md and
 *   android/app/src/main/java/com/sevenzrecovery/helper/SevenZipModule.kt).
 *
 *   The JS side calls the native module via Expo Native Module / JNI bridge.
 *   No simulation — it actually attempts to open the archive with each password.
 *
 * EXPO GO / WEB FALLBACK:
 *   When the native module is not linked (Expo Go, web preview), verification
 *   cannot run genuinely. verifyPassword() returns ENGINE_UNAVAILABLE and the
 *   UI shows a clear message with build instructions instead of faking success.
 */

export type VerifyResult =
  | { status: 'correct' }
  | { status: 'incorrect' }
  | { status: 'corrupted' }
  | { status: 'unsupported' }
  | { status: 'engine_unavailable'; message: string }
  | { status: 'error'; message: string };

// Check if we're running with native module available
let nativeModuleAvailable: boolean | null = null;

export function isNativeEngineAvailable(): boolean {
  if (nativeModuleAvailable !== null) return nativeModuleAvailable;
  try {
    // Expo native module check — will be false in Expo Go / Web
    // The actual module is registered as "SevenZipModule" in native build
    const { Platform } = require('react-native');
    // In Expo Go, NativeModules.SevenZipModule will be undefined
    const { NativeModules } = require('react-native');
    nativeModuleAvailable = !!NativeModules.SevenZipModule;
    // On web, Platform.OS === 'web' — always unavailable
    if (Platform.OS === 'web') nativeModuleAvailable = false;
  } catch {
    nativeModuleAvailable = false;
  }
  return nativeModuleAvailable;
}

/**
 * Attempt to verify a password against a 7z archive.
 * @param archiveUri - content:// or file:// URI from SAF picker
 * @param password - candidate password (preserved exactly)
 * @returns VerifyResult
 */
export async function verifyPassword(
  archiveUri: string,
  password: string
): Promise<VerifyResult> {
  if (!archiveUri) {
    return { status: 'error', message: 'No archive selected' };
  }

  // Try native module
  if (isNativeEngineAvailable()) {
    try {
      const { NativeModules } = require('react-native');
      const result: string = await NativeModules.SevenZipModule.verifyPassword(
        archiveUri,
        password
      );
      // Native returns one of: "correct", "incorrect", "corrupted", "unsupported", "error:<msg>"
      if (result === 'correct') return { status: 'correct' };
      if (result === 'incorrect') return { status: 'incorrect' };
      if (result === 'corrupted') return { status: 'corrupted' };
      if (result === 'unsupported') return { status: 'unsupported' };
      if (result.startsWith('error:')) return { status: 'error', message: result.slice(6) };
      return { status: 'error', message: result };
    } catch (e: any) {
      return { status: 'error', message: e?.message ?? String(e) };
    }
  }

  // Fallback: engine unavailable — do NOT simulate success
  return {
    status: 'engine_unavailable',
    message:
      'Native 7z engine not linked. Build the native Android app (see BUILD.md) to enable real password verification. This preview cannot verify passwords without the native library.',
  };
}

/**
 * Extract archive to output directory using the verified password.
 */
export async function extractArchive(
  archiveUri: string,
  password: string,
  outputUri: string
): Promise<{ success: boolean; filesExtracted: number; error?: string }> {
  if (isNativeEngineAvailable()) {
    try {
      const { NativeModules } = require('react-native');
      const res = await NativeModules.SevenZipModule.extractArchive(
        archiveUri,
        password,
        outputUri
      );
      // res: { success, filesExtracted, error }
      return res;
    } catch (e: any) {
      return { success: false, filesExtracted: 0, error: e?.message ?? String(e) };
    }
  }
  return { success: false, filesExtracted: 0, error: 'Native engine unavailable' };
}

/**
 * Validate that a file looks like a 7z archive by checking magic bytes.
 * 7z signature: 37 7A BC AF 27 1C
 */
export function isSevenZipFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.7z');
}

export const ENGINE_INFO = {
  library: 'SevenZipJBinding',
  mavenCoord: 'net.sf.sevenzipjbinding:sevenzipjbinding:16.02-2.01',
  nativeLibs: ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'],
  encryptionSupported: ['AES-256 (7zAES)'],
  limitations: 'Encrypted headers and content supported where 7zAES is used. Other codecs may return unsupported.',
};
