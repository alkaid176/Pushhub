package app.pushhub.android.service

import app.pushhub.android.machine.Status
import app.pushhub.android.protocol.MessageFrame
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/**
 * SpikeLog —— spike 结构化事件 JSONL 落盘（D-85 数据源，06-01 Task 3）。
 *
 * 连接状态变迁与消息到达事件写入应用私有目录 filesDir/spike-log/<yyyy-MM-dd>.jsonl，
 * 供 SC1 spike（8 小时锁屏验证）次日导出分析："可区分第几小时断线"。
 *
 * 导出方式（debuggable 包）：adb exec-out run-as app.pushhub.android cat
 * files/spike-log/<yyyy-MM-dd>.jsonl
 *
 * 写失败静默忽略——日志不得反噬主链路（连接/消息路径永不因落盘失败受阻）。
 */
class SpikeLog(private val dir: File) {

    private val dateFormatter = DateTimeFormatter.ISO_LOCAL_DATE

    /** 连接状态变迁事件。 */
    fun status(channel: String, status: Status) {
        append(
            buildJsonObject {
                put("ts", System.currentTimeMillis())
                put("type", "status")
                put("channel", channel)
                put("status", status.name.lowercase())
            },
        )
    }

    /** 消息到达事件（实时帧——通知触发的唯一消息流，D-61/D-63）。 */
    fun messageArrived(channel: String, message: MessageFrame) {
        append(
            buildJsonObject {
                put("ts", System.currentTimeMillis())
                put("type", "message_arrived")
                put("channel", channel)
                put("wid", message.wid)
                put("seq", message.seq)
            },
        )
    }

    private fun append(event: JsonObject) {
        try {
            if (!dir.isDirectory) dir.mkdirs()
            val file = File(dir, "${LocalDate.now().format(dateFormatter)}.jsonl")
            file.appendText(event.toString() + "\n")
        } catch (e: Exception) {
            // 静默忽略（类注释纪律）。
        }
    }
}
