package app.pushhub.android.config

import android.util.Log
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.SerializationException
import app.pushhub.android.protocol.lenientJson
import java.io.File

/**
 * 频道配置（06-04 Task 1 完整化，D-79/D-87）。
 *
 * id 是内部稳定标识（单调序 ch1..chN，永不复用——删除后 max+1 继续递增）：
 * 通知通道 ID 用 id 不用 name（D-87 不可变纪律——通道 ID 一旦发布即用户系统
 * 设置锚点，频道改名不得换通道；06-05 NotificationRouter 消费）。name 是
 * 用户可见名（重名禁止，见 [ConfigError.DuplicateChannel]）。
 */
@Serializable
data class ChannelConfig(
    val id: String,
    val name: String,
    val key: String,
)

/**
 * 应用配置（对齐桌面 config.rs 字段面，06-04 Task 1 完整化）。
 *
 * server 为服务端地址（生产入口 https://pushhub.dyun.org）；channels 上限
 * [ConfigStore.MAX_CHANNELS]（D-79）；displayName 为回复展示名（D-72 全局
 * 一项，缺省 null = 匿名回复——by 键不序列化）。
 */
@Serializable
data class Config(
    var server: String = "",
    val channels: MutableList<ChannelConfig> = mutableListOf(),
    var displayName: String? = null,
)

/**
 * 配置操作错误（sealed——UI 层按类型转文案，异常本身不携带用户输入内容）。
 *
 * 消息刻意为空：Channel Key 是机密，错误对象不内嵌任何字段值（T-06-04-02）；
 * UI 层（向导/频道管理）switch 类型映射静态文案。
 */
sealed class ConfigError : Exception() {
    /** 超出频道上限（D-79 = 8）。 */
    class ChannelLimitReached : ConfigError()

    /** 已存在同名频道。 */
    class DuplicateChannel : ConfigError()

    /** 操作的频道 id 不存在（已被删除或配置外部变更）。 */
    class ChannelNotFound : ConfigError()
}

/**
 * 配置存储（06-01 minimal → 06-04 Task 1 完整化）。
 *
 * Channel Key 是机密（T-06-04-02 mitigate）：
 *  - 仅存应用私有存储（filesDir——调用方注入目录）；
 *  - 损坏时日志为单行静态短句，不含文件内容与异常 message 原文
 *    （config.rs:78-90 同构纪律——kotlinx 异常 message 可能回显 JSON 片段）；
 *  - 保存原子（临时文件 + renameTo——半写配置不得上线）。
 *
 * 目录注入构造（JVM 可测）；warn 注入日志函数（JVM 测试捕获日志行断言
 * 不含密钥子串——默认 android.util.Log，测试传 lambda）。
 *
 * 频道增删改经本类的 load-modify-save 方法（上限/重名校验在此层收口——
 * UI 只捕获 [ConfigError] 转文案，不自行校验）。
 */
class ConfigStore(
    private val dir: File,
    private val warn: (String) -> Unit = { msg -> Log.w(TAG, msg) },
) {

    private val file: File get() = File(dir, FILE_NAME)

    /** 读取配置；文件缺失/JSON 损坏/字段缺失 → 空默认配置 + 单行静态短句日志。 */
    fun load(): Config {
        if (!file.isFile) return Config()
        return try {
            lenientJson.decodeFromString(Config.serializer(), file.readText())
        } catch (e: SerializationException) {
            // 静态短句：不含文件内容，不内嵌异常 message（可能回显 JSON 片段）。
            warn("config file corrupted; using defaults")
            Config()
        } catch (e: Exception) {
            warn("config file unreadable; using defaults")
            Config()
        }
    }

    /** 原子保存：临时文件写全 + renameTo 覆盖；失败抛出由调用方处理。 */
    fun save(config: Config) {
        if (!dir.isDirectory) dir.mkdirs()
        val tmp = File(dir, "$FILE_NAME.tmp")
        tmp.writeText(lenientJson.encodeToString(config))
        if (!tmp.renameTo(file)) {
            // 目标已存在时 renameTo 可能失败（平台差异）——删除目标后重试一次。
            file.delete()
            check(tmp.renameTo(file)) { "config save failed" }
        }
    }

    /**
     * 新增频道（向导保存/管理页添加消费）。超限/重名抛 [ConfigError]；
     * id 为永不复用的单调序（D-87）。返回新建的频道配置。
     */
    fun addChannel(name: String, key: String): ChannelConfig {
        val config = load()
        if (config.channels.size >= MAX_CHANNELS) throw ConfigError.ChannelLimitReached()
        if (config.channels.any { it.name == name }) throw ConfigError.DuplicateChannel()
        val channel = ChannelConfig(id = nextChannelId(config.channels), name = name, key = key)
        config.channels.add(channel)
        save(config)
        return channel
    }

    /**
     * 编辑频道（改名/换 Key——id 恒不变，D-87 通道锚纪律）。id 不存在抛
     * [ConfigError.ChannelNotFound]；新名与其他频道撞名抛 [ConfigError.DuplicateChannel]。
     */
    fun updateChannel(id: String, name: String, key: String) {
        val config = load()
        val channel = config.channels.firstOrNull { it.id == id }
            ?: throw ConfigError.ChannelNotFound()
        if (config.channels.any { it.id != id && it.name == name }) {
            throw ConfigError.DuplicateChannel()
        }
        config.channels[config.channels.indexOf(channel)] = channel.copy(name = name, key = key)
        save(config)
    }

    /** 删除频道（id 不存在抛 [ConfigError.ChannelNotFound]）。 */
    fun removeChannel(id: String) {
        val config = load()
        val removed = config.channels.removeAll { it.id == id }
        if (!removed) throw ConfigError.ChannelNotFound()
        save(config)
    }

    /**
     * 下一个频道 id：ch<max+1>（既有 id 中 ch 前缀数字最大值 +1，空集从 1 起）。
     * 永不复用已删除 id——通知通道锚（D-87）不因复用而串台。
     */
    private fun nextChannelId(channels: List<ChannelConfig>): String {
        val max = channels.maxOfOrNull { ch ->
            ch.id.removePrefix(ID_PREFIX).toIntOrNull() ?: 0
        } ?: 0
        return "$ID_PREFIX${max + 1}"
    }

    companion object {
        const val TAG = "ConfigStore"
        const val FILE_NAME = "config.json"

        /** 多频道上限（D-79，对齐桌面 D-64 心智统一）。 */
        const val MAX_CHANNELS = 8

        private const val ID_PREFIX = "ch"
    }
}
