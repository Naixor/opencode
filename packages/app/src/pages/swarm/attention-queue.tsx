export function AttentionQueue(props: { swarmId: string }) {
  return (
    <div class="flex flex-col gap-2 p-3 rounded-lg bg-gray-900 border border-gray-800 min-h-[120px]">
      <h3 class="text-xs font-semibold text-gray-400 uppercase">Attention Queue</h3>
      <div class="text-xs text-gray-500">No items need your attention</div>
    </div>
  )
}
