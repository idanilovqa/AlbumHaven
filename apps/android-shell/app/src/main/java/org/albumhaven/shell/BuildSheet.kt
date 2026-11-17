package org.albumhaven.shell

import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.text.format.DateUtils
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.RadioButton
import android.widget.TextView
import android.widget.Toast
import androidx.annotation.StringRes
import androidx.core.view.isVisible
import org.albumhaven.shell.updates.BuildChoice
import org.albumhaven.shell.updates.BuildPicker
import org.albumhaven.shell.updates.RebuildResult
import org.albumhaven.shell.updates.Rebuilds

/**
 * Choose app build (approved mockup v003 B): one row per sandbox whose build this app does not
 * have. A newer build installs, switching sandbox when it is another's; an older one can only be
 * rebuilt under a newer version code, which keeps every sign-in.
 */
class BuildSheet(
    private val activity: Activity,
    private val picker: BuildPicker,
    private val installedVersionCode: Long,
    private val deviceApi: Int,
    private val currentSandbox: () -> Int?,
    private val onInstall: (BuildChoice) -> Unit,
) {
    private var dialog: Dialog? = null
    private var root: View? = null

    /** The chosen row's version code; kept across refreshes while that build is still offered. */
    private var selected: Long? = null

    val showing: Boolean get() = dialog?.isShowing == true

    fun show() {
        if (showing) return render()
        val view = LayoutInflater.from(activity).inflate(R.layout.build_sheet, null)
        root = view
        view.findViewById<Button>(R.id.build_sheet_cancel).setOnClickListener { dismiss() }
        dialog = Dialog(activity).apply {
            setContentView(view)
            setOnDismissListener {
                dialog = null
                root = null
            }
            window?.apply {
                setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
                setGravity(Gravity.BOTTOM)
                setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            }
            show()
        }
        selected = null
        render()
        capHeight(view)
    }

    fun dismiss() {
        dialog?.dismiss()
    }

    /** The index changed: show what it offers now. */
    fun render() {
        val view = root ?: return
        val choices = picker.choices.orEmpty()
        if (choices.isEmpty()) return dismiss()
        val sandbox = currentSandbox()
        view.findViewById<TextView>(R.id.build_sheet_installed).text =
            activity.getString(R.string.build_sheet_installed, installedVersionCode, sandbox ?: 0)
        if (choices.none { it.build.versionCode == selected && it.installable }) {
            selected = choices.firstOrNull { it.installable }?.build?.versionCode
        }
        val rows = view.findViewById<ViewGroup>(R.id.build_sheet_rows)
        rows.removeAllViews()
        choices.forEach { choice -> rows.addView(row(rows, choice)) }
        val chosen = choices.firstOrNull { it.build.versionCode == selected }
        view.findViewById<Button>(R.id.build_sheet_install).apply {
            isEnabled = chosen != null
            text = when {
                chosen == null || chosen.thisSandbox -> activity.getString(R.string.build_sheet_install, chosen?.build?.versionCode ?: 0)
                else -> activity.getString(R.string.build_sheet_switch_install)
            }
            setOnClickListener {
                chosen ?: return@setOnClickListener
                dismiss()
                onInstall(chosen)
            }
        }
    }

    private val BuildChoice.installable: Boolean get() = newer && supported

    private fun row(parent: ViewGroup, choice: BuildChoice): View {
        val build = choice.build
        val row = LayoutInflater.from(activity).inflate(R.layout.build_sheet_row, parent, false)
        val chosen = build.versionCode == selected
        row.isSelected = chosen
        row.isEnabled = choice.installable
        row.alpha = if (choice.supported) 1f else DISABLED_ALPHA
        row.findViewById<RadioButton>(R.id.build_row_radio).apply {
            isChecked = chosen
            isEnabled = choice.installable
        }
        row.findViewById<TextView>(R.id.build_row_title).text =
            activity.getString(R.string.build_row_title, build.sandbox, build.versionCode)
        row.findViewById<TextView>(R.id.build_row_meta).text = activity.getString(
            R.string.build_row_meta,
            build.title,
            build.sourceCommit.take(SHORT_COMMIT),
            DateUtils.getRelativeTimeSpanString(build.publishedAt.toEpochMilli()),
        )
        val note = row.findViewById<TextView>(R.id.build_row_note)
        val rebuild = row.findViewById<Button>(R.id.build_row_rebuild)
        val running = picker.rebuilding(build.sandbox)
        note.setTextColor(activity.getColor(if (choice.newer && choice.supported) R.color.sheet_muted else R.color.warning))
        note.text = when {
            !choice.supported -> activity.getString(R.string.build_row_unsupported, build.minAndroidApi, deviceApi)
            running != null -> activity.getString(
                R.string.build_row_rebuilding,
                DateUtils.getRelativeTimeSpanString(running.requestedAtMs),
            )
            !choice.newer -> activity.getString(R.string.build_row_older, installedVersionCode)
            choice.thisSandbox -> activity.getString(R.string.build_row_this_sandbox)
            else -> activity.getString(R.string.build_row_switches, build.sandbox)
        }
        rebuild.isVisible = choice.supported && !choice.newer && running == null
        rebuild.setOnClickListener { requestRebuild(choice, rebuild) }
        if (choice.installable) {
            row.setOnClickListener {
                selected = build.versionCode
                render()
            }
        }
        return row
    }

    private fun requestRebuild(choice: BuildChoice, button: Button) {
        button.isEnabled = false
        picker.rebuild(choice.build) { result ->
            if (activity.isDestroyed) return@rebuild
            when (result) {
                RebuildResult.STARTED -> toast(R.string.build_rebuild_started)
                RebuildResult.UNAVAILABLE -> showCommand(Rebuilds.command(choice.build))
                RebuildResult.ALREADY_RUNNING -> toast(R.string.build_rebuild_running)
                RebuildResult.TOO_MANY -> toast(R.string.build_rebuild_too_many)
                RebuildResult.FAILED -> toast(R.string.build_rebuild_failed)
            }
            render()
        }
    }

    /** Without a rebuild token on this sandbox, the owner runs the same promotion from the PC. */
    private fun showCommand(command: String) {
        AlertDialog.Builder(activity)
            .setTitle(R.string.build_rebuild_command_title)
            .setMessage(activity.getString(R.string.build_rebuild_command_message, command))
            .setPositiveButton(R.string.build_rebuild_command_copy) { _, _ ->
                activity.getSystemService(ClipboardManager::class.java)
                    .setPrimaryClip(ClipData.newPlainText(activity.getString(R.string.build_rebuild_command_title), command))
                toast(R.string.build_rebuild_command_copied)
            }
            .setNegativeButton(R.string.build_sheet_cancel, null)
            .show()
    }

    /** The sheet never covers more than most of the screen; its rows scroll instead. */
    private fun capHeight(view: View) {
        view.post {
            val max = (activity.resources.displayMetrics.heightPixels * MAX_HEIGHT_FRACTION).toInt()
            val excess = view.height - max
            if (excess <= 0) return@post
            val scroll = view.findViewById<View>(R.id.build_sheet_scroll)
            scroll.layoutParams = scroll.layoutParams.apply { height = scroll.height - excess }
        }
    }

    private fun toast(@StringRes message: Int) = Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()

    private companion object {
        const val SHORT_COMMIT = 7
        const val DISABLED_ALPHA = 0.55f
        const val MAX_HEIGHT_FRACTION = 0.85f
    }
}
