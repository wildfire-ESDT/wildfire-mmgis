import React from 'react'
import useWhatIfStore from '../../store'
import { addInput } from '../../demo'
import { Select } from '@design/components'

const GROUPS = ['Weather', 'Terrain', 'Fuel']

export default function AddLayerPicker() {
    const mapLayers = useWhatIfStore((s) => (s.activeDemo && s.inputCatalogs[s.activeDemo]) || [])
    const added = useWhatIfStore((s) => s.addedInputKeys)
    const options = GROUPS.flatMap((group) =>
        mapLayers
            .filter((layer) => layer.group === group && !added.includes(layer.key))
            .map((layer) => ({ value: layer.key, label: `${group} · ${layer.label}` }))
    )
    if (!options.length) return null
    return <Select value={null} placeholder="Add layer" options={options} onValueChange={(key) => key && addInput(key)} />
}
