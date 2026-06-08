import type { FC } from 'react'
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'

/**
 * 回环边上方拱形路径：从右侧 output 起笔向右伸出 c，上拱到 peakY，再从左侧落回 target input，
 * 避免回指边从右侧穿过中间节点。多条回环边按 loopIndex 抬高 lift 错开，避免重叠。
 */
function loopArcPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  loopIndex: number,
): string {
  const c = 60 // 起笔/收笔水平伸出量，避免贴住源/目标节点
  const lift = 80 + loopIndex * 28
  const peakY = Math.min(sourceY, targetY) - lift
  const midX = (sourceX + targetX) / 2
  return (
    `M ${sourceX},${sourceY} ` +
    `C ${sourceX + c},${sourceY} ${sourceX + c},${peakY} ${midX},${peakY} ` +
    `C ${targetX - c},${peakY} ${targetX - c},${targetY} ${targetX},${targetY}`
  )
}

/** 曲线路径；回环边（data.isLoop）改走上方拱形绕行 */
const MidArrowEdge: FC<EdgeProps> = (props) => {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
    data,
  } = props

  const loopIndex = typeof data?.loopIndex === 'number' ? data.loopIndex : 0
  // output在input右侧大于一定距离时 走上方回环
  const edgePath =
    sourceX - targetX > 120
      ? loopArcPath(sourceX, sourceY, targetX, targetY, loopIndex)
      : getBezierPath({
          sourceX,
          sourceY,
          sourcePosition,
          targetX,
          targetY,
          targetPosition,
          curvature: 0.6,
        })[0]

  return <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
}

export default MidArrowEdge
