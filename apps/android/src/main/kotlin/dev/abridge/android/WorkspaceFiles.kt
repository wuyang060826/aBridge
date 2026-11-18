package dev.abridge.android

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

internal class Refusal(val code: String, message: String) : Exception(message)

internal class WorkspaceFiles(private val context: Context) {
    private val resolver = context.contentResolver

    fun authorizedTree(): Uri? {
        val tree = context.devicePreferences.getString("tree", null)?.let(Uri::parse) ?: return null
        return tree.takeIf { resolver.persistedUriPermissions.any { p ->
            p.uri == tree && p.isReadPermission && p.isWritePermission
        } }
    }

    private data class Entry(val id: String, val name: String, val mime: String, val size: Long, val modified: Long) {
        val directory get() = mime == Document.MIME_TYPE_DIR
    }

    private fun children(tree: Uri, parent: String, visit: (Entry) -> Boolean) {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
        val columns = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED)
        val cursor = resolver.query(uri, columns, null, null, null)
            ?: throw Refusal("directory_unavailable", "Could not read the selected directory")
        cursor.use { while (it.moveToNext()) {
            if (!visit(Entry(it.getString(0), it.getString(1), it.getString(2), it.getLong(3), it.getLong(4)))) break
        } }
    }

    fun execute(tool: String, args: JSONObject, check: () -> Unit): JSONObject {
        val tree = authorizedTree() ?: throw Refusal("capability_unavailable", "Choose a directory to authorize file access")
        val path = args.getString("path")
        val relative = when {
            path == "/workspace" || path == "/workspace/" -> ""
            path.startsWith("/workspace/") -> path.removePrefix("/workspace/")
            else -> throw Refusal("path_outside_workspace", "Use a path inside /workspace")
        }
        val parts = if (relative.isEmpty()) emptyList() else relative.split('/')
        if (parts.size > 128 || parts.any { it.isEmpty() || it == "." || it == ".." || '\u0000' in it })
            throw Refusal("invalid_path", "Use valid names inside /workspace")
        var id = DocumentsContract.getTreeDocumentId(tree)
        var entry: Entry? = null
        for ((index, part) in parts.withIndex()) {
            if (entry?.directory == false) throw Refusal("not_directory", "A parent path is not a directory")
            entry = null
            children(tree, id) { candidate ->
                check()
                if (candidate.name == part) {
                    if (entry != null) throw Refusal("ambiguous_path", "The provider returned duplicate names")
                    entry = candidate
                }
                true
            }
            if (entry == null) {
                if (tool == "file_write" && index == parts.lastIndex) break
                throw Refusal("file_not_found", "The requested path was not found")
            }
            id = entry!!.id
        }

        return when (tool) {
            "files_list" -> {
                if (entry?.directory == false) throw Refusal("not_directory", "Select a directory")
                val limit = args.optInt("limit", 200)
                val entries = mutableListOf<Entry>()
                var truncated = false
                children(tree, id) {
                    check()
                    if (entries.size == limit) { truncated = true; false }
                    else { entries.add(it); true }
                }
                JSONObject().put("path", path).put("truncated", truncated)
                    .put("entries", JSONArray(entries.sortedBy { it.name }.map {
                        JSONObject().put("name", it.name).put("is_directory", it.directory)
                            .put("is_symlink", false).put("size", it.size)
                            .put("modified_at", it.modified / 1000.0)
                    }))
            }
            "file_read" -> {
                if (entry == null || entry.directory) throw Refusal("unsupported_file_type", "Select a file")
                val limit = args.optInt("max_bytes", 1048576)
                val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)
                val buffer = ByteArray(8192)
                val bytes = ByteArrayOutputStream()
                val input = resolver.openInputStream(uri)
                    ?: throw Refusal("file_unavailable", "The file could not be opened")
                input.use {
                    while (true) {
                        check()
                        val count = it.read(buffer, 0, minOf(buffer.size, limit + 1 - bytes.size()))
                        if (count < 0) break
                        bytes.write(buffer, 0, count)
                        if (bytes.size() > limit) throw Refusal("file_too_large", "The file exceeds the requested limit")
                    }
                }
                val text = try {
                    Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                        .decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
                } catch (_: CharacterCodingException) {
                    throw Refusal("unsupported_encoding", "The file is not valid UTF-8")
                }
                JSONObject().put("path", path).put("content", text).put("size", bytes.size())
            }
            "file_write" -> {
                if (parts.isEmpty() || entry?.directory == true) throw Refusal("unsupported_file_type", "Select a file")
                val exists = entry != null
                if (exists && !args.optBoolean("overwrite", false))
                    throw Refusal("file_exists", "The requested file already exists")
                val encoded = try {
                    Charsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
                        .encode(CharBuffer.wrap(args.getString("content")))
                } catch (_: CharacterCodingException) {
                    throw Refusal("invalid_arguments", "Text must be valid Unicode")
                }
                if (encoded.remaining() > 1048576) throw Refusal("invalid_arguments", "Text exceeds one MiB")
                val bytes = ByteArray(encoded.remaining()).also { encoded.get(it) }
                check()
                val document = DocumentsContract.buildDocumentUriUsingTree(tree, id)
                val uri = if (exists) document else DocumentsContract.createDocument(resolver, document, "text/plain", parts.last())
                    ?: error("Document creation could not be confirmed")
                // Providers may append an extension or pick a unique name. Never report a different path as success.
                if (!exists) {
                    val actual = resolver.query(uri, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)
                        ?.use { if (it.moveToFirst()) it.getString(0) else null }
                    if (actual != parts.last()) {
                        DocumentsContract.deleteDocument(resolver, uri)
                        throw Refusal("unsupported_filename", "The provider could not create the exact filename")
                    }
                }
                check()
                resolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
                    ?: error("Write could not be confirmed")
                JSONObject().put("path", path).put("size", bytes.size).put("overwritten", exists)
            }
            else -> throw Refusal("unsupported_tool", "This file operation is unavailable")
        }
    }
}
