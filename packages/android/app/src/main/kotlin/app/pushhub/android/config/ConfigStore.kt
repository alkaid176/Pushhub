package app.pushhub.android.config

import android.util.Log
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.SerializationException
import app.pushhub.android.protocol.lenientJson
import java.io.File

/** 频道配置（D-79：上限 8 由向导/管理页约束，存储层不重复校验）。 */
@Serializable
data class ChannelConfig(
    val id: String,
    val name: String,
    val key: String,
)

/**
 * 应用配置（minimal 版，06-01 Task 3）。server 为服务端地址（生产入口
 * https://pushhub.dyun.org）；displayName 为回复展示名（D-72，缺省匿名回复）。
 */
@Serializable
data class Config(
    val server: String = "",
    val channels: List<ChannelConfig> = emptyList(),
    val displayName: String? = null,
)

/**
 * 配置存储（06-01 Task 3 minimal——向导 UI 在 06-04 接入读写）。
 *
 * Channel Key 是机密：仅存应用私有存储（filesDir，T-06-01-01 mitigate）；
 * 损坏时日志为静态短句不含文件内容（config.rs:78-90 同构纪律）；save 原子
 * （临时文件 + renameTo——半写配置不得上线）。
 *
 * load 注入目录（构造参数）——JVM 测试可直接指向临时目录。
 */
class ConfigStore(private val dir: File) {

    private val file: File get() = File(dir, FILE_NAME)

    /** 读取配置；文件缺失/损坏 → 空默认配置 + 静态短句日志（不含文件内容）。 */
    fun load(): Config {
        if (!file.isFile) return Config()
        return try {
            lenientJson.decodeFromString(Config.serializer(), file.readText())
        } catch (e: SerializationException) {
            Log.w(TAG, "config file corrupted; using defaults")
            Config()
        } catch (e: Exception) {
            Log.w(TAG, "config file unreadable; using defaults")
            Config()
        }
    }

    /** 原子保存：临时文件写全 + renameTo 覆盖。 */
    fun save(config: Config) {
        if (!dir.isDirectory) dir.mkdirs()
        val tmp = File(dir, "$FILE_NAME.tmp")
        tmp.writeText(lenientJson.encodeToString(config))
        if (!tmp.renameTo(file)) {
            // Windows 上目标已存在时 renameTo 可能失败——删除目标后重试一次。
            file.delete()
            check(tmp.renameTo(file)) { "config save failed" }
        }
    }

    private companion object {
        const val TAG = "ConfigStore"
        const val FILE_NAME = "config.json"
    }
}
