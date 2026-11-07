namespace WorkBuddy.Workbench;

/// <summary>
/// Which kind of episode the startup attempt ended as. These are deliberately distinct because a
/// bound that expired, a step that cancelled itself, and a window the user closed are different
/// facts: reporting any of them as "cancelled" or "stopped" would hide a hang behind a user action
/// that never happened.
/// </summary>
internal enum StartupOutcome
{
    Idle,
    Starting,
    Ready,
    Failed,
    TimedOut,
    Interrupted,
    Closed,
}

/// <summary>A single step the shell entered, with the time it took to get there.</summary>
internal sealed record StartupTransition(string Stage, int ElapsedMs, int BoundMs, long AtUnixMs);

/// <summary>
/// Accounts for one native-shell startup episode: which stage it reached, how long each stage took,
/// which step it is currently waiting on and for how long, and — when the attempt did not reach
/// <c>ready</c> — why. Pure state; it never touches a window, a process, or a profile, so the
/// transitions can be exercised without a desktop session.
/// </summary>
internal sealed class StartupProgress
{
    /// <summary>How long the local recording service may take to print its first frame.</summary>
    internal const int HostReadyBudgetMs = 20_000;

    /// <summary>How long WebView2 may take to build the user data environment.</summary>
    internal const int WebViewEnvironmentBudgetMs = 30_000;

    /// <summary>How long the controller may take to attach to the environment.</summary>
    internal const int ControllerBudgetMs = 30_000;

    /// <summary>How long the loaded page may take to report a successful navigation.</summary>
    internal const int NavigationBudgetMs = 45_000;

    /// <summary>Recorded for a synchronous step; a blocking call cannot be bounded, only timed.</summary>
    internal const int SynchronousBoundMs = 0;

    private readonly Func<long> ticks;
    private readonly List<StartupTransition> transitions = new();
    private long startedAt;
    private long stageStartedAt;
    private string stage = "created";
    private string? awaitingStage;
    private int awaitingBoundMs;
    private long awaitingSince;
    private StartupOutcome outcome = StartupOutcome.Idle;
    private string? failureCode;
    private string? failureStage;
    private string? failureDetail;

    internal StartupProgress(Func<long>? clock = null) => ticks = clock ?? (static () => Environment.TickCount64);

    internal StartupOutcome Outcome => outcome;
    internal string Stage => stage;
    internal string? FailureCode => failureCode;
    internal string? FailureStage => failureStage;
    internal string? FailureDetail => failureDetail;
    internal IReadOnlyList<StartupTransition> Transitions => transitions;
    internal bool IsFailed => outcome is StartupOutcome.Failed or StartupOutcome.TimedOut or StartupOutcome.Interrupted;

    /// <summary>
    /// Claims the single startup episode. A second call while an episode is still running returns
    /// false, so a retry button pressed twice cannot start two hosts or two environments.
    /// </summary>
    internal bool TryBegin()
    {
        if (outcome == StartupOutcome.Starting) return false;
        transitions.Clear();
        failureCode = null; failureStage = null; failureDetail = null;
        awaitingStage = null; awaitingBoundMs = 0;
        outcome = StartupOutcome.Starting;
        stage = "created";
        startedAt = ticks(); stageStartedAt = startedAt;
        return true;
    }

    /// <summary>Releases the claim without claiming an outcome of its own.</summary>
    internal void End()
    {
        if (outcome == StartupOutcome.Starting) outcome = StartupOutcome.Idle;
    }

    internal void Enter(string name)
    {
        stage = name;
        stageStartedAt = ticks();
        awaitingStage = null; awaitingBoundMs = 0; awaitingSince = 0;
        transitions.Add(new StartupTransition(name, Elapsed(startedAt), SynchronousBoundMs, Now()));
    }

    /// <summary>Marks the step currently being waited on, so a hang is observable while it hangs.</summary>
    internal void Await(string name, int boundMs)
    {
        if (stage != name) Enter(name);
        awaitingStage = name; awaitingBoundMs = boundMs; awaitingSince = ticks();
        if (transitions.Count > 0 && transitions[^1].Stage == name)
            transitions[^1] = transitions[^1] with { BoundMs = boundMs };
    }

    internal void Ready()
    {
        outcome = StartupOutcome.Ready;
        stage = "ready"; stageStartedAt = ticks();
        awaitingStage = null; awaitingBoundMs = 0; awaitingSince = 0;
        transitions.Add(new StartupTransition("ready", Elapsed(startedAt), SynchronousBoundMs, Now()));
    }

    internal void Fail(string code, string detail)
    {
        outcome = StartupOutcome.Failed;
        failureCode = code; failureDetail = detail; failureStage = stage;
        awaitingStage = null; awaitingBoundMs = 0; awaitingSince = 0;
    }

    /// <summary>A bound expired. The stage that hung stays as the current stage on purpose.</summary>
    internal void TimeOut(string name, int boundMs, string detail)
    {
        outcome = StartupOutcome.TimedOut;
        stage = name;
        failureCode = "timeout:" + name; failureDetail = detail; failureStage = name;
    }

    /// <summary>
    /// A step cancelled itself while the window stayed open. This is not the operator closing the
    /// window, and it is not proof that anything stopped.
    /// </summary>
    internal void Interrupt(string name, string detail)
    {
        outcome = StartupOutcome.Interrupted;
        stage = name;
        failureCode = "interrupted:" + name; failureDetail = detail; failureStage = name;
    }

    /// <summary>The operator closed the window mid-episode; nothing else is implied about the host.</summary>
    internal void Close()
    {
        outcome = StartupOutcome.Closed;
        failureDetail = "window closed while waiting on " + (awaitingStage ?? stage);
        awaitingStage = null; awaitingBoundMs = 0; awaitingSince = 0;
    }

    /// <summary>
    /// The bounded, redacted startup facts carried by the window snapshot. <c>awaitingMs</c> keeps
    /// growing while a step hangs, so a status read during a hang explains the wait instead of
    /// reporting only the last stage that succeeded.
    /// </summary>
    internal object Describe() => new
    {
        outcome = OutcomeName(outcome),
        startupStage = stage,
        stageElapsedMs = Elapsed(stageStartedAt),
        awaitingStage,
        awaitingMs = awaitingStage is null ? (int?)null : Elapsed(awaitingSince),
        awaitingBoundedMs = awaitingStage is null ? (int?)null : awaitingBoundMs,
        transitions = transitions.Select(item => new { stage = item.Stage, elapsedMs = item.ElapsedMs, boundMs = item.BoundMs, atUnixMs = item.AtUnixMs }).ToArray(),
        failureCode,
        failureStage,
        failureDetail,
    };

    private int Elapsed(long mark) => (int)Math.Min(int.MaxValue, ticks() - mark);

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static string OutcomeName(StartupOutcome value) => value switch
    {
        StartupOutcome.Idle => "idle",
        StartupOutcome.Starting => "starting",
        StartupOutcome.Ready => "ready",
        StartupOutcome.Failed => "failed",
        StartupOutcome.TimedOut => "timeout",
        StartupOutcome.Interrupted => "interrupted",
        StartupOutcome.Closed => "closed",
        _ => "unknown",
    };
}

/// <summary>A startup step did not finish inside its bound. Never reported as a cancellation.</summary>
internal sealed class StartupStepTimeoutException : Exception
{
    internal StartupStepTimeoutException(string stage, int boundMs, string reason, Exception? inner = null)
        : base($"Startup step '{stage}' did not finish within {boundMs} ms ({reason}).", inner)
    {
        Stage = stage; BoundMs = boundMs;
    }

    internal string Stage { get; }
    internal int BoundMs { get; }
}

/// <summary>
/// Runs one startup step with an explicit bound and records its transition before waiting. The bound
/// is imposed with <see cref="Task.WaitAsync(TimeSpan, CancellationToken)"/> only: the step's own
/// token is never cancelled by the bound, so an expiry surfaces as a timeout rather than as a
/// cancellation the shell could mistake for the operator closing the window.
/// </summary>
internal static class StartupStep
{
    internal static async Task<T> RunAsync<T>(StartupProgress progress, string stage, int boundMs, Func<CancellationToken, Task<T>> work, CancellationToken lifetime)
    {
        ArgumentNullException.ThrowIfNull(progress);
        ArgumentNullException.ThrowIfNull(work);
        progress.Enter(stage);
        progress.Await(stage, boundMs);
        try
        {
            return boundMs > 0
                ? await work(lifetime).WaitAsync(TimeSpan.FromMilliseconds(boundMs), lifetime)
                : await work(lifetime);
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested)
        {
            progress.Close();
            throw;
        }
        catch (OperationCanceledException error)
        {
            progress.Interrupt(stage, "the step cancelled itself while the window stayed open");
            throw new StartupStepTimeoutException(stage, boundMs, "cancelled by the step, not by the window", error);
        }
        catch (TimeoutException error)
        {
            progress.TimeOut(stage, boundMs, "the step did not return within its bound");
            throw new StartupStepTimeoutException(stage, boundMs, "bound expired", error);
        }
    }

    internal static Task RunAsync(StartupProgress progress, string stage, int boundMs, Func<CancellationToken, Task> work, CancellationToken lifetime)
        => RunAsync(progress, stage, boundMs, async token => { await work(token); return true; }, lifetime);

    /// <summary>A synchronous step can be timed but not bounded; <c>boundMs</c> stays 0.</summary>
    internal static void Run(StartupProgress progress, string stage, Action work)
    {
        ArgumentNullException.ThrowIfNull(work);
        Run(progress, stage, () => { work(); return true; });
    }

    internal static T Run<T>(StartupProgress progress, string stage, Func<T> work)
    {
        ArgumentNullException.ThrowIfNull(progress);
        ArgumentNullException.ThrowIfNull(work);
        progress.Enter(stage);
        progress.Await(stage, StartupProgress.SynchronousBoundMs);
        return work();
    }
}

/// <summary>
/// The single host process this window owns. A retry, an exit event, or a shutdown may only touch a
/// host this window still owns, so a stale handler from an earlier episode can never terminate the
/// host that replaced it.
/// </summary>
internal sealed class OwnedHost<T> where T : class, IDisposable
{
    private T? current;

    internal T? Current => Volatile.Read(ref current);

    internal void Adopt(T next)
    {
        ArgumentNullException.ThrowIfNull(next);
        Interlocked.Exchange(ref current, next);
    }

    internal bool Owns(T candidate) => ReferenceEquals(Current, candidate);

    /// <summary>Returns the host only when this window still owns it; otherwise returns null.</summary>
    internal T? ReleaseIfOwned(T candidate) => Owns(candidate) ? Interlocked.Exchange(ref current, null) : null;
}
