import { memo } from 'react';
import { BaseEdge, EdgeProps, getSmoothStepPath } from '@xyflow/react';

const SummaryEdge = ({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style = {},
    markerEnd,
    data,
}: EdgeProps) => {
    let centerY;
    if (data?.isIngress) {
        // Turn right just after start (source)
        centerY = sourceY + 20;
    } else if (data?.isEgress) {
        // Turn left just before end (target)
        centerY = targetY - 20;
    }

    const [edgePath] = getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        centerY,
    });

    return (
        <>
            <BaseEdge
                path={edgePath}
                markerEnd={markerEnd}
                style={{
                    strokeDasharray: '5,5', // Dashed line to indicate "bypass" or "alternative"
                    ...style,
                }}
            />
        </>
    );
};

export default memo(SummaryEdge);
