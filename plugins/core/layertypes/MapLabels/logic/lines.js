// Walking line geometries in degrees.

/** The position arrays of a line geometry; anything else has none. */
export function linePiecesOf(geometry) {
    if (geometry.type === 'LineString') return [geometry.coordinates]
    if (geometry.type === 'MultiLineString') return geometry.coordinates
    return []
}

export function lineLengthDegrees(coordinates) {
    let length = 0
    for (let index = 1; index < coordinates.length; index++) {
        length += Math.hypot(coordinates[index][0] - coordinates[index - 1][0],
            coordinates[index][1] - coordinates[index - 1][1])
    }
    return length
}

/** Points every `spacing` along a line, starting half a spacing in; a line shorter than that gets its midpoint. */
export function pointsAlongLine(coordinates, spacing) {
    const lineLength = lineLengthDegrees(coordinates)
    if (lineLength === 0) return []
    const targetDistances = []
    if (lineLength < spacing) targetDistances.push(lineLength / 2)
    for (let distance = spacing / 2; distance < lineLength; distance += spacing) targetDistances.push(distance)

    const points = []
    let distanceAtSegmentStart = 0
    let segmentIndex = 1
    for (const targetDistance of targetDistances) {
        while (segmentIndex < coordinates.length) {
            const [startLongitude, startLatitude] = coordinates[segmentIndex - 1]
            const [endLongitude, endLatitude] = coordinates[segmentIndex]
            const segmentLength = Math.hypot(endLongitude - startLongitude, endLatitude - startLatitude)
            if (distanceAtSegmentStart + segmentLength >= targetDistance) {
                const fraction = segmentLength === 0 ? 0 : (targetDistance - distanceAtSegmentStart) / segmentLength
                points.push([
                    startLongitude + (endLongitude - startLongitude) * fraction,
                    startLatitude + (endLatitude - startLatitude) * fraction,
                ])
                break
            }
            distanceAtSegmentStart += segmentLength
            segmentIndex++
        }
    }
    return points
}
