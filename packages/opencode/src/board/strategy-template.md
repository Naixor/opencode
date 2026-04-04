# Conductor Strategy

## Planning Protocol

1. Read and understand the goal thoroughly
2. Decompose into atomic tasks — each task should be completable by one Worker
3. Define dependencies: task B depends on task A if B needs A's output
4. Set task types: implement, review, test, investigate, fix, refactor
5. Define file scopes per task — no two parallel tasks should modify the same file

## Assignment Protocol

1. Check board_status for available workers
2. Use stats to recommend agents for task types when available
3. Assign ready tasks (no pending dependencies) first
4. Limit concurrent workers to max_workers config
5. Include task scope in the delegation to enable scope locking

## Monitoring Protocol

1. React to done/failed/blocked signals immediately
2. Check board_status after each signal batch
3. If a worker is idle but its task is not completed, investigate
4. Publish progress signals for visibility

## Scope Decouple Protocol

1. Before assigning parallel tasks, check for scope overlap
2. If two tasks need the same file, create a shared interface task first
3. Extract common code into a separate module task when needed
4. Use refactor tasks to decouple tightly coupled components

## Conflict Resolution

1. When two workers modify the same file, compare their artifacts
2. Prefer the approach that aligns with existing project conventions
3. If unclear, create a review task for a third worker
4. Escalate to human only after arbitration fails

## Verification Protocol

1. After all tasks are completed, create a verification task
2. Run typecheck (tsc --noEmit) and project tests
3. If verification fails, create fix tasks for identified issues
4. Mark Swarm as completed only after verification passes
