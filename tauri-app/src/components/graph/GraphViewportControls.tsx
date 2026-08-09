import { Panel, useReactFlow, useStore } from '@xyflow/react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { cn } from '../../lib/utils';

const CONTROL_BUTTONS = [
    { id: 'zoom-in', label: 'Zoom in', icon: Plus },
    { id: 'zoom-out', label: 'Zoom out', icon: Minus },
    { id: 'fit-view', label: 'Fit graph to view', icon: Maximize2 },
] as const;

export function GraphViewportControls() {
    const { fitView, zoomIn, zoomOut } = useReactFlow();
    const zoom = useStore((state) => state.transform[2]);
    const zoomLabel = `${Math.round((zoom || 1) * 100)}%`;

    const handleControl = (id: typeof CONTROL_BUTTONS[number]['id']) => {
        if (id === 'zoom-in') {
            void zoomIn({ duration: 180 });
            return;
        }
        if (id === 'zoom-out') {
            void zoomOut({ duration: 180 });
            return;
        }
        void fitView({ padding: 0.28, duration: 260 });
    };

    return (
        <Panel position="bottom-left" className="agentree-graph-viewport-controls-panel">
            <div
                className="react-flow__controls agentree-graph-viewport-controls"
                aria-label="Graph viewport controls"
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
            >
                <div className="agentree-graph-viewport-controls__readout">
                    <span className="agentree-graph-viewport-controls__eyebrow">Zoom</span>
                    <span className="agentree-graph-viewport-controls__value">{zoomLabel}</span>
                </div>
                <div className="agentree-graph-viewport-controls__actions" role="group" aria-label="Zoom and fit controls">
                    {CONTROL_BUTTONS.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            type="button"
                            className={cn(
                                'react-flow__controls-button',
                                'agentree-graph-viewport-controls__button'
                            )}
                            aria-label={label}
                            title={label}
                            onClick={() => handleControl(id)}
                        >
                            <Icon aria-hidden="true" size={14} strokeWidth={2} />
                        </button>
                    ))}
                </div>
            </div>
        </Panel>
    );
}
