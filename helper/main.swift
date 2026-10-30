import Cocoa
import QuickLookUI

// MARK: - 协议

private struct RectPayload: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

private struct Command: Decodable {
    let cmd: String
    let path: String?
    let bounds: RectPayload?
    let anchor: RectPayload?
}

// MARK: - 控制器
//
// 用苹果官方的 QLPreviewPanel，不再自绘。依据是 SDK 头文件
// QuickLookUI.framework/Headers/QLPreviewPanel.h 的原文：
//
//   "Each application has only one instance of QLPreviewPanel. You can not subclass QLPreviewPanel."
//   "QLPreviewPanel follows the responder chain and adapts to the first responder willing to control it."
//   "Return NSZeroRect if there is no origin point, this will produce a fade of the panel."
//     —— 即 delegate 的 sourceFrameOnScreenForPreviewItem，官方专门给 zoom effect 留的钩子。
//
// 居中位置、按屏幕比例的尺寸、从源矩形缩放的动画、Esc/空格/左右键、双指缩放，
// 全部由系统负责；我们只提供「预览哪个文件」和「它从屏幕上哪块矩形长大」。

private final class PreviewController: NSObject, NSApplicationDelegate, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    private var host: NSWindow!
    private var isShowing = false
    /// 打开面板前正在前台的应用（通常是 DSH），收起时把焦点还回去。
    private var previousApp: NSRunningApplication?
    private var url: URL?
    private var anchorRect: NSRect = .zero

    func applicationDidFinishLaunching(_ notification: Notification) {
        // QLPreviewPanel 靠 responder chain 找控制器，链的起点是 key window。
        // 留一个透明的 1x1 窗口当宿主，既给得出 key，又不会闪出多余窗口。
        host = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        host.isOpaque = false
        host.backgroundColor = .clear
        host.alphaValue = 0
        host.ignoresMouseEvents = true
        host.orderFront(nil)

        startCommandLoop()

        // 预热：面板第一次 makeKeyAndOrderFront 要 ~72ms（建窗口 + 唤醒 quicklookd），
        // 用户能看见这一下卡顿。这里在屏幕外先把它建起来再收掉，把这笔开销提前吃掉。
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            // 用户可能在预热前就按了空格，那面板已经归他用了，不能再拿去预热。
            guard let self, !self.isShowing else { return }
            self.prewarm()
        }
    }

    private func prewarm() {
        guard !isShowing else { return }
        guard let panel = QLPreviewPanel.shared() else { return }
        let warmURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("dsh-macos-quicklook-warmup.txt")
        try? "warm up".write(to: warmURL, atomically: true, encoding: .utf8)
        url = warmURL
        anchorRect = .zero
        panel.dataSource = self
        panel.delegate = self
        // 放在屏幕外：用户看不见，但走完"第一次把面板真放上屏幕"的全过程
        // （建窗口 + 首次合成 + 唤醒 quicklookd）。实测这一步要 74ms，
        // 不预热的话就是用户第一次按空格时那下卡顿。
        panel.setFrame(NSRect(x: -4000, y: -4000, width: 480, height: 360), display: false)
        panel.orderFrontRegardless()
        panel.reloadData()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            // 临时文件无条件删：面板已经被用户接手时也要删，
            // 否则每个 helper 实例都在临时目录里留一份残留。
            try? FileManager.default.removeItem(at: warmURL)
            guard let self, !self.isShowing else { return }
            panel.orderOut(nil)
            self.url = nil
        }
    }

    // MARK: 命令

    private func startCommandLoop() {
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine(strippingNewline: true) {
                guard !line.isEmpty else { continue }
                guard let data = line.data(using: .utf8),
                      let command = try? JSONDecoder().decode(Command.self, from: data) else { continue }
                DispatchQueue.main.async { [weak self] in
                    self?.handle(command)
                }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func handle(_ command: Command) {
        switch command.cmd {
        case "show":
            guard let path = command.path, !path.isEmpty else { return }
            show(path: path, bounds: command.bounds, anchor: command.anchor)
        case "toggle":
            guard let path = command.path, !path.isEmpty else { return }
            toggle(path: path, bounds: command.bounds, anchor: command.anchor)
        case "hide":
            hide()
        case "focus":
            // 把宿主应用（DeepSeek Harness）提到前台。网页里的 window.focus() 不一定
            // 能把整个 app 激活，焦点回不去时按空格会被系统吃掉，这里做系统级兜底。
            if let host = NSWorkspace.shared.runningApplications.first(where: {
                $0.bundleIdentifier == "com.deepseek.dsh"
            }) {
                host.activate()
                log("focus -> DeepSeek Harness")
            }
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    private func log(_ text: String) {
        let line = "\(Date().timeIntervalSince1970) \(text)\n"
        guard let data = line.data(using: .utf8) else { return }
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".dsh/logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("quicklook-helper.log").path
        if let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: path)) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            // 首次创建就把权限收到只有本人可读：日志里有会话号与文件路径。
            FileManager.default.createFile(
                atPath: path,
                contents: data,
                attributes: [.posixPermissions: 0o600]
            )
        }
    }

    /// 面板此刻开没开只有这里知道（用户按 Esc 时是系统自己关的，浏览器侧收不到）。
    /// 所以「按空格」统一走这里判定：同文件就收起，否则显示/切换。
    private func toggle(path: String, bounds: RectPayload?, anchor: RectPayload?) {
        let nextURL = URL(fileURLWithPath: path)
        if isShowing, let panel = QLPreviewPanel.shared(), panel.isVisible, url == nextURL {
            hide()
            return
        }
        show(path: path, bounds: bounds, anchor: anchor)
    }

    private func show(path: String, bounds: RectPayload?, anchor: RectPayload?) {
        let nextURL = URL(fileURLWithPath: path)
        let nextAnchor = cardRect(anchor: anchor, bounds: bounds)
        let debug = ProcessInfo.processInfo.environment["QL_DEBUG"] != nil
        var t0 = Date()
        func mark(_ label: String) {
            guard debug else { return }
            let now = Date()
            let line = String(format: "  %@ +%.1fms\n", label, now.timeIntervalSince(t0) * 1000)
            FileHandle.standardError.write(line.data(using: .utf8)!)
            t0 = now
        }

        guard let panel = QLPreviewPanel.shared() else {
            log("show: no panel")
            return
        }

        // 这次打开作废任何还在跑着的收起收尾。
        hideGeneration += 1

        // 面板已经开着、换到另一个文件：直接把内容换掉，不做任何过渡。
        if isShowing && panel.isVisible && url != nextURL {
            url = nextURL
            anchorRect = nextAnchor
            panel.dataSource = self
            panel.delegate = self
            panel.alphaValue = 1
            panel.reloadData()
            log("swap path=\(path) visible=\(panel.isVisible)")
            return
        }

        url = nextURL
        anchorRect = nextAnchor

        // 这里刻意不让 host 抢 key：QLPreviewPanel 一旦失去 key window 就会自己收起，
        // 而 host 是 1×1 的透明窗口，之前它 makeKey 之后面板会在 ~1s 后被系统关掉
        // （日志里表现为 after1.2s visible=false）。host 只负责让 accessory app 有可见窗口。
        focusGeneration += 1
        rememberFrontmost()
        host.orderFrontRegardless()
        mark("host.orderFront")
        NSApp.activate(ignoringOtherApps: true)
        mark("NSApp.activate")

        // makeKeyAndOrderFront 会让系统顺着 responder chain 找到本对象并调
        // beginPreviewPanelControl，dataSource 在那里接上，所以 reloadData 放在后面。
        panel.dataSource = self
        panel.delegate = self
        // 上一次收起可能把 alpha 拉到 0 还没收完，这里先复位，否则这次"打开"是透明的。
        panel.alphaValue = 1
        // 面板显示后到应用真正激活有延迟，先把层级抬到浮动层，避免被 DSH 窗口盖住。
        panel.level = .floating
        // QLPreviewPanel 是 NSPanel 子类，默认 hidesOnDeactivate = true：
        // helper 是后台进程、从不成为 active app，面板于是被系统自动藏起来
        // （isVisible 仍是 true），这就是"按下没反应、过一会儿才出现"的根因。
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.makeKeyAndOrderFront(nil)
        mark("panel.makeKeyAndOrderFront")
        panel.reloadData()
        mark("panel.reloadData")
        isShowing = true
        log("show path=\(path) visible=\(panel.isVisible) key=\(panel.isKeyWindow) appActive=\(NSApp.isActive) hostVisible=\(host.isVisible) hostKey=\(host.isKeyWindow)")

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            self.log("after1.2s visible=\(panel.isVisible) key=\(panel.isKeyWindow) appActive=\(NSApp.isActive) hostVisible=\(self.host.isVisible) hostKey=\(self.host.isKeyWindow) items=\(self.numberOfPreviewItems(in: panel))")
        }
    }

    private func hide() {
        isShowing = false
        hideGeneration += 1
        let token = hideGeneration
        log("hide")
        // 还焦点必须放在可见性判断之前。否则"面板已经被系统关掉、又收到一次 hide"
        // 这条路径会直接 return，previousApp 一直残留；而 rememberFrontmost 只在
        // previousApp == nil 时记录，之后就永远把焦点还给那个陈旧的应用。
        restoreFocusSoon()
        guard let panel = QLPreviewPanel.shared(), panel.isVisible else { return }
        // 收回：不追求缩回卡片（公开 API 做不到，见 b40 记录）。
        // orderOut 自带的淡出约 0.19s、而且是原地缩小，观感拖沓；
        // 这里先用 0.1s 把窗口 alpha 拉掉再收掉，让消失更干脆。
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.10
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().alphaValue = 0
        } completionHandler: { [weak self, weak panel] in
            guard let self, let panel else { return }
            // 这 0.1s 里用户又按了空格：收起的代号已经变了，这次收尾作废，
            // 只把透明度复位，别把新面板关掉。
            guard token == self.hideGeneration else {
                panel.alphaValue = 1
                return
            }
            panel.orderOut(nil)
            panel.alphaValue = 1
        }
    }

    /// 记住面板出现前的前台应用，只在第一次记录，避免连续操作时记成自己。
    private func rememberFrontmost() {
        guard previousApp == nil else { return }
        guard let front = NSWorkspace.shared.frontmostApplication else { return }
        guard front.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
        previousApp = front
    }

    /// 系统的收回动画要 ~0.25s，这期间 helper 必须还是前台应用——
    /// 否则我们一 activate(DSH)，helper 立刻失活，面板会"啪"地消失而不是缩回卡片。
    /// 所以还焦点要等动画播完；期间若用户又打开了预览，就把这次挂起的还焦点取消。
    private var focusGeneration = 0
    /// 每发起一次收起就 +1；收起的动画收尾只有拿到同一个代号才允许真正收掉。
    /// 否则「按空格收起 → 100ms 内又按一次打开」时，前一次的收尾会把新面板关掉。
    private var hideGeneration = 0

    private func restoreFocusSoon() {
        focusGeneration += 1
        let generation = focusGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) { [weak self] in
            guard let self, generation == self.focusGeneration else { return }
            self.restoreFocus()
        }
    }

    /// 收起后把焦点还给原应用。用 NSRunningApplication.activate()，
    /// 不调 NSApp.hide（那会把整个 helper 藏起来、下次还要重新激活）。
    private func restoreFocus() {
        guard let app = previousApp else { return }
        previousApp = nil
        let ok = app.activate()
        log("restoreFocus -> \(app.localizedName ?? "?") ok=\(ok)")
    }

    // MARK: 卡片在屏幕上的位置

    private func cardRect(anchor: RectPayload?, bounds: RectPayload?) -> NSRect {
        guard let anchor, let bounds else {
            log("cardRect missing anchor=\(String(describing: anchor)) bounds=\(String(describing: bounds))")
            return .zero
        }
        let window = screenRect(bounds)
        // anchor 是网页坐标（距视口顶部），AppKit 的原点在左下，这里必须再翻一次，
        // 否则动画起点会整体下移（实测偏 ~93px）。
        let rect = NSRect(
            x: window.minX + CGFloat(anchor.x),
            y: window.minY + (window.height - CGFloat(anchor.y) - CGFloat(anchor.height)),
            width: CGFloat(anchor.width),
            height: CGFloat(anchor.height)
        )
        log("cardRect anchor=(\(anchor.x),\(anchor.y),\(anchor.width),\(anchor.height)) bounds=(\(bounds.x),\(bounds.y),\(bounds.width),\(bounds.height)) window=\(window) -> \(rect)")
        return rect
    }

    /// CSS 像素（左上原点）→ 屏幕坐标（左下原点）。以主屏 frame.maxY 为翻转基准，
    /// 副屏在上方时也不会算错。
    private func screenRect(_ rect: RectPayload) -> NSRect {
        let desktopHeight = NSScreen.screens
            .first { $0.frame.origin == .zero }?.frame.maxY
            ?? NSScreen.screens.map { $0.frame.maxY }.max() ?? 0
        return NSRect(
            x: CGFloat(rect.x),
            y: desktopHeight - CGFloat(rect.y) - CGFloat(rect.height),
            width: CGFloat(rect.width),
            height: CGFloat(rect.height)
        )
    }

    // MARK: QLPreviewPanelDataSource

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int {
        url == nil ? 0 : 1
    }

    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
        url as NSURL?
    }

    // MARK: QLPreviewPanelDelegate

    /// 官方 zoom effect 钩子：返回文件在屏幕上的原始矩形，面板打开/关闭时就从这里缩放。
    /// 返回 .zero 则退化成淡入。
    func previewPanel(_ panel: QLPreviewPanel!, sourceFrameOnScreenFor item: QLPreviewItem!) -> NSRect {
        log("sourceFrame -> \(anchorRect) visible=\(panel.isVisible)")
        return anchorRect
    }

    // MARK: 接管 / 交还控制权（这三个由系统自己发，不要直接调用）

    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool { true }

    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) {
        panel.dataSource = self
        panel.delegate = self
    }

    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) {
        // 面板真的不在了才算"关掉了"；它只是交还控制权但仍在屏幕上时，
        // 别把 isShowing 抹掉，否则随后那次 0.45s 的释放会让它变成个空壳。
        if !panel.isVisible {
            isShowing = false
        }
        let stamp = Date().timeIntervalSince1970
        log("endPreviewPanelControl \(stamp)")
        // 头文件原文：sourceFrameOnScreenForPreviewItem 在「打开和关闭」时都会被调用。
        // 之前这里立刻把 dataSource/delegate 拆掉，关闭时系统就问不到源矩形了，
        // 收回退化成缩向屏幕中心的淡出（打开时却有 10 次调用、是从卡片放大的）。
        // 延迟到收回动画结束再拆。
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self, weak panel] in
            guard let self, let panel, !self.isShowing else { return }
            panel.dataSource = nil
            panel.delegate = nil
            self.log("control released")
        }
        // 用户按 Esc 或点别处时，面板是系统自己关掉的，不会走我们的 hide()，
        // 所以把「还焦点」挂在这里——无论哪条路径关闭都会经过这个系统回调。
        restoreFocusSoon()
    }
}

private let application = NSApplication.shared
private let controller = PreviewController()
application.delegate = controller
application.setActivationPolicy(.accessory)
application.run()
