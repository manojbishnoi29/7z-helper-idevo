package com.sevenzrecovery.helper

import android.content.ContentResolver
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import net.sf.sevenzipjbinding.*
import net.sf.sevenzipjbinding.impl.RandomAccessFileInStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

class SevenZipModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "SevenZipModule"

    /**
     * Copies content:// uri to a temp file for RandomAccessFile access required by SevenZipJBinding.
     */
    private fun copyToTempFile(uri: Uri): File? {
        return try {
            val resolver: ContentResolver = reactContext.contentResolver
            val pfd: ParcelFileDescriptor = resolver.openFileDescriptor(uri, "r") ?: return null
            val tempFile = File.createTempFile("sz_verify", ".7z", reactContext.cacheDir)
            pfd.use { fd ->
                ParcelFileDescriptor.AutoCloseInputStream(fd).use { inp ->
                    FileOutputStream(tempFile).use { out ->
                        val buf = ByteArray(8192)
                        var n: Int
                        while (inp.read(buf).also { n = it } != -1) out.write(buf, 0, n)
                    }
                }
            }
            tempFile
        } catch (e: Exception) {
            null
        }
    }

    @ReactMethod
    fun verifyPassword(archiveUri: String, password: String, promise: Promise) {
        var tempFile: File? = null
        var raf: RandomAccessFile? = null
        var archive: IInArchive? = null
        try {
            val uri = Uri.parse(archiveUri)
            tempFile = copyToTempFile(uri)
            if (tempFile == null || !tempFile.exists() || tempFile.length() == 0L) {
                promise.resolve("error:Archive file not found or empty")
                return
            }

            // Headers may be encrypted — open requires no password yet.
            // Password is provided at extract time via callback.
            raf = RandomAccessFile(tempFile, "r")
            try {
                archive = SevenZip.openInArchive(null, RandomAccessFileInStream(raf))
            } catch (e: Exception) {
                val msg = (e.message ?: "").lowercase()
                when {
                    msg.contains("not 7z") || msg.contains("not a 7z") || msg.contains("unknown archive") -> {
                        promise.resolve("unsupported")
                        return
                    }
                    msg.contains("header") -> {
                        promise.resolve("corrupted")
                        return
                    }
                    else -> {
                        promise.resolve("error:${e.message}")
                        return
                    }
                }
            }

            // Archive opened — check if encrypted by probing items
            val numItems = archive.numberOfItems
            if (numItems == 0) {
                promise.resolve("correct")
                return
            }

            // Try extracting first non-directory item with password.
            // SevenZipJBinding: use callback extractor with password.
            var foundNonDir = -1
            for (i in 0 until numItems) {
                val isFolder = archive.getProperty(i, PropID.IS_FOLDER) as? Boolean ?: false
                if (!isFolder) { foundNonDir = i; break }
            }
            if (foundNonDir == -1) {
                promise.resolve("correct")
                return
            }

            val extractIndices = intArrayOf(foundNonDir)
            val errors = mutableListOf<Exception>()

            try {
                val result = archive.extract(
                    extractIndices,
                    false,
                    object : IArchiveExtractCallback {
                        override fun getStream(index: Int, extractAskMode: ExtractAskMode): ISequentialOutStream? {
                            if (extractAskMode != ExtractAskMode.EXTRACT) return null
                            return object : ISequentialOutStream {
                                override fun write(data: ByteArray): Int = data.size
                            }
                        }
                        override fun prepareOperation(askMode: ExtractAskMode) {}
                        override fun setOperationResult(result: ExtractOperationResult) {
                            if (result != ExtractOperationResult.OK) {
                                errors.add(RuntimeException("Extract failed: $result"))
                            }
                        }
                        override fun setTotal(total: Long) {}
                        override fun setCompleted(complete: Long) {}
                    }
                )
            } catch (e: Exception) {
                val msg = (e.message ?: "")
                if (msg.contains("password", ignoreCase = true) || msg.contains("wrong", ignoreCase = true) || msg.contains("data error", ignoreCase = true)) {
                    // Need to try with password via CryptoGetTextPassword
                    // Retry with password callback
                    errors.clear()
                    try {
                        val result2 = archive.extract(
                            extractIndices,
                            false,
                            object : IArchiveExtractCallback, ICryptoGetTextPassword {
                                override fun getStream(index: Int, extractAskMode: ExtractAskMode): ISequentialOutStream? {
                                    if (extractAskMode != ExtractAskMode.EXTRACT) return null
                                    return object : ISequentialOutStream {
                                        override fun write(data: ByteArray): Int = data.size
                                    }
                                }
                                override fun prepareOperation(askMode: ExtractAskMode) {}
                                override fun setOperationResult(result: ExtractOperationResult) {
                                    if (result != ExtractOperationResult.OK) {
                                        errors.add(RuntimeException("Extract failed: $result"))
                                    }
                                }
                                override fun setTotal(total: Long) {}
                                override fun setCompleted(complete: Long) {}
                                override fun cryptoGetTextPassword(): String = password
                            }
                        )
                        if (errors.isEmpty()) {
                            promise.resolve("correct")
                        } else {
                            val errMsg = errors.firstOrNull()?.message ?: ""
                            if (errMsg.contains("DATA_ERROR") || errMsg.contains("CRC") || errors.any { it.message?.contains("DATA_ERROR") == true }) {
                                promise.resolve("incorrect")
                            } else {
                                promise.resolve("error:$errMsg")
                            }
                        }
                    } catch (e2: Exception) {
                        val m2 = (e2.message ?: "")
                        if (m2.contains("password", ignoreCase = true) || m2.contains("wrong", ignoreCase = true)) {
                            promise.resolve("incorrect")
                        } else {
                            promise.resolve("error:$m2")
                        }
                    }
                    return
                }
                // For archives without password callback, incorrect manifests as DATA_ERROR
                if (msg.contains("DATA_ERROR", ignoreCase = true) || msg.contains("CRC", ignoreCase = true)) {
                    promise.resolve("incorrect")
                } else {
                    promise.resolve("error:$msg")
                }
                return
            }

            if (errors.isEmpty()) {
                // No password needed — archive not encrypted, any password considered correct
                promise.resolve("correct")
            } else {
                val errMsg = errors.first().message ?: ""
                if (errMsg.contains("DATA_ERROR") || errMsg.contains("CRC")) {
                    // Without crypto callback, encrypted archive fails as DATA_ERROR
                    // Try again with password callback to distinguish
                    errors.clear()
                    try {
                        archive.extract(
                            extractIndices,
                            false,
                            object : IArchiveExtractCallback, ICryptoGetTextPassword {
                                override fun getStream(index: Int, extractAskMode: ExtractAskMode): ISequentialOutStream? {
                                    if (extractAskMode != ExtractAskMode.EXTRACT) return null
                                    return object : ISequentialOutStream { override fun write(data: ByteArray): Int = data.size }
                                }
                                override fun prepareOperation(askMode: ExtractAskMode) {}
                                override fun setOperationResult(result: ExtractOperationResult) {
                                    if (result != ExtractOperationResult.OK) errors.add(RuntimeException("Extract failed: $result"))
                                }
                                override fun setTotal(total: Long) {}
                                override fun setCompleted(complete: Long) {}
                                override fun cryptoGetTextPassword(): String = password
                            }
                        )
                        promise.resolve(if (errors.isEmpty()) "correct" else "incorrect")
                    } catch (e2: Exception) {
                        promise.resolve("incorrect")
                    }
                } else {
                    promise.resolve("error:$errMsg")
                }
            }

        } catch (e: Exception) {
            val msg = (e.message ?: "")
            when {
                msg.contains("not 7z", ignoreCase = true) || msg.contains("unknown", ignoreCase = true) -> promise.resolve("unsupported")
                msg.contains("header", ignoreCase = true) -> promise.resolve("corrupted")
                else -> promise.resolve("error:$msg")
            }
        } finally {
            try { archive?.close() } catch (_: Exception) {}
            try { raf?.close() } catch (_: Exception) {}
            try { tempFile?.delete() } catch (_: Exception) {}
        }
    }

    @ReactMethod
    fun extractArchive(archiveUri: String, password: String, outputUri: String, promise: Promise) {
        var tempFile: File? = null
        var raf: RandomAccessFile? = null
        var archive: IInArchive? = null
        try {
            val srcUri = Uri.parse(archiveUri)
            val outTreeUri = Uri.parse(outputUri)
            tempFile = copyToTempFile(srcUri)
            if (tempFile == null) {
                promise.resolve(createFail("Source archive not found"))
                return
            }
            val outDir = DocumentFile.fromTreeUri(reactContext, outTreeUri)
            if (outDir == null || !outDir.canWrite()) {
                promise.resolve(createFail("Output folder not writable — select a trusted folder"))
                return
            }

            raf = RandomAccessFile(tempFile, "r")
            archive = try {
                SevenZip.openInArchive(null, RandomAccessFileInStream(raf))
            } catch (e: Exception) {
                promise.resolve(createFail(e.message ?: "Failed to open archive"))
                return
            }

            val numItems = archive.numberOfItems
            var extracted = 0
            for (i in 0 until numItems) {
                val path = (archive.getProperty(i, PropID.PATH) as? String) ?: "file_$i"
                val isFolder = archive.getProperty(i, PropID.IS_FOLDER) as? Boolean ?: false

                // Normalize path — prevent directory traversal
                val safePath = path.replace("\\", "/").trimStart('/')
                if (safePath.contains("..")) continue

                if (isFolder) {
                    ensureDir(outDir, safePath)
                    continue
                }

                // Ensure parent dirs
                val parentPath = safePath.substringBeforeLast("/", "")
                val parent = if (parentPath.isEmpty()) outDir else ensureDir(outDir, parentPath)

                val fileName = safePath.substringAfterLast("/")
                if (parent.findFile(fileName) != null) {
                    // Skip — prevent overwrite
                    continue
                }

                val mime = when (fileName.substringAfterLast(".", "").lowercase()) {
                    "txt" -> "text/plain"; "jpg", "jpeg" -> "image/jpeg"; "png" -> "image/png"
                    else -> "application/octet-stream"
                }
                val docFile = parent.createFile(mime, fileName) ?: continue
                val outStream = reactContext.contentResolver.openOutputStream(docFile.uri) ?: continue

                val extractErr = mutableListOf<String>()
                try {
                    archive.extract(
                        intArrayOf(i), false,
                        object : IArchiveExtractCallback, ICryptoGetTextPassword {
                            override fun getStream(index2: Int, askMode: ExtractAskMode): ISequentialOutStream? {
                                if (askMode != ExtractAskMode.EXTRACT) return null
                                return object : ISequentialOutStream {
                                    override fun write(data: ByteArray): Int {
                                        outStream.write(data)
                                        return data.size
                                    }
                                }
                            }
                            override fun prepareOperation(askMode: ExtractAskMode) {}
                            override fun setOperationResult(result: ExtractOperationResult) {
                                if (result != ExtractOperationResult.OK) extractErr.add(result.toString())
                            }
                            override fun setTotal(total: Long) {}
                            override fun setCompleted(complete: Long) {}
                            override fun cryptoGetTextPassword(): String = password
                        }
                    )
                } finally {
                    try { outStream.close() } catch (_: Exception) {}
                }

                if (extractErr.isEmpty()) extracted++
                else {
                    // Remove partially written file
                    try { docFile.delete() } catch (_: Exception) {}
                }
            }

            val map = com.facebook.react.bridge.Arguments.createMap()
            map.putBoolean("success", true)
            map.putInt("filesExtracted", extracted)
            map.putString("error", null)
            promise.resolve(map)

        } catch (e: Exception) {
            promise.resolve(createFail(e.message ?: "Extraction failed"))
        } finally {
            try { archive?.close() } catch (_: Exception) {}
            try { raf?.close() } catch (_: Exception) {}
            try { tempFile?.delete() } catch (_: Exception) {}
        }
    }

    private fun createFail(msg: String): com.facebook.react.bridge.WritableMap {
        val m = com.facebook.react.bridge.Arguments.createMap()
        m.putBoolean("success", false)
        m.putInt("filesExtracted", 0)
        m.putString("error", msg)
        return m
    }

    private fun ensureDir(root: DocumentFile, relativePath: String): DocumentFile {
        var cur = root
        val parts = relativePath.split("/").filter { it.isNotEmpty() }
        for (part in parts) {
            var next = cur.findFile(part)
            if (next == null) {
                next = cur.createDirectory(part) ?: cur
            }
            cur = next
        }
        return cur
    }
}
