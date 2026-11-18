using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace ABridge;

internal sealed class HostBridge : IDisposable
{
    private readonly Process process;
    private readonly SemaphoreSlim writes = new(1, 1);
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonElement>> pending = new();
    private long sequence;
    private bool disposed;
    private bool gracefulExit;
    public event Action<JsonElement>? Event;
    public event Action? Disconnected;
    public bool IsRunning { get { try { return !process.HasExited; } catch (Exception) { return false; } } }

    public HostBridge(string stateDir)
    {
        var runtime = Path.Combine(AppContext.BaseDirectory, "runtime");
        var start = new ProcessStartInfo(Path.Combine(runtime, "node.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8,
            WorkingDirectory = runtime
        };
        start.ArgumentList.Add(Path.Combine(runtime, "windows-host.mjs"));
        start.ArgumentList.Add("--state-dir"); start.ArgumentList.Add(stateDir);
        start.ArgumentList.Add("--parent-pid"); start.ArgumentList.Add(Environment.ProcessId.ToString());
        process = Process.Start(start) ?? throw new IOException("无法启动设备内核。");
        _ = Pump();
        _ = DrainErrors();
    }
    private async Task DrainErrors()
    {
        try { var buffer = new char[4096]; while (await process.StandardError.ReadAsync(buffer) > 0) { } }
        catch (Exception) { /* Native diagnostics never enter UI or logs. */ }
    }
    private async Task Pump()
    {
        try
        {
            while (await process.StandardOutput.ReadLineAsync() is { } line)
            {
                if (line.Length > 131072) throw new IOException("本机响应过大。");
                using var document = JsonDocument.Parse(line);
                var value = document.RootElement.Clone();
                if (value.TryGetProperty("id", out var id) && id.TryGetInt64(out var key) && pending.TryRemove(key, out var completion))
                {
                    if (value.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True) completion.TrySetResult(value);
                    else completion.TrySetException(new IOException(Text(value, "error", "本机操作失败。")));
                }
                else if (value.TryGetProperty("event", out _)) Event?.Invoke(value);
            }
        }
        catch (Exception) { }
        finally
        {
            foreach (var item in pending.Values) item.TrySetException(new IOException("本机连接已关闭。"));
            pending.Clear();
            Disconnected?.Invoke();
        }
    }
    public async Task<JsonElement> Request(string action, object? args = null)
    {
        if (disposed) throw new IOException("设备内核已退出。");
        long id = 0;
        var completion = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            await writes.WaitAsync();
            try
            {
                id = ++sequence;
                pending[id] = completion;
                await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { id, action, args = args ?? new { } }));
                await process.StandardInput.FlushAsync();
            }
            finally { writes.Release(); }
            var result = await completion.Task.WaitAsync(TimeSpan.FromSeconds(action == "bind" ? 310 : action == "quit" ? 45 : 25));
            if (action == "quit") gracefulExit = true;
            return result;
        }
        finally { pending.TryRemove(id, out _); }
    }
    public static string Text(JsonElement value, string key, string fallback = "") => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() ?? fallback : fallback;
    public static bool Flag(JsonElement value, string key) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var item) && item.ValueKind == JsonValueKind.True;
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        try { process.StandardInput.Close(); if (!process.WaitForExit(1500) && !gracefulExit) process.Kill(true); } catch (Exception) { }
        process.Dispose();
    }
}
