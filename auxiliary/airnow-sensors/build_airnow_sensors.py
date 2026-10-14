#!/usr/bin/env python3
"""Builds the AirNow sensors layer

Each sensor includes its observed PM2.5 and AQI, along with forecasts from recent runs.
"""
import argparse
import gzip
import json
import subprocess
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

BUCKET = 's3://wildfire-esdt-ard-cog'
OBSERVED_KEY = 'la-airnow-pm25/airnow_pm25_30d.geojson'
STATIONS_FOLDER = 'la-pm25-predictions/stations/'
DATA_FOLDER = Path(__file__).resolve().parents[2] / 'Missions/Wildfire/Data/airnow-sensors'

PM25_AQI_BREAKPOINTS = [
    (0.0, 9.0, 0, 50),
    (9.1, 35.4, 51, 100),
    (35.5, 55.4, 101, 150),
    (55.5, 125.4, 151, 200),
    (125.5, 225.4, 201, 300),
    (225.5, 325.4, 301, 500),
]


def read_json(contents):
    if contents[:2] == b'\x1f\x8b':
        contents = gzip.decompress(contents)
    return json.loads(contents)


def read_from_s3(key):
    return read_json(subprocess.run(['aws', 's3', 'cp', f'{BUCKET}/{key}', '-', '--only-show-errors'],
                                    check=True, capture_output=True).stdout)


def read_recent_runs(cache_folder, days):
    subprocess.run(['aws', 's3', 'sync', f'{BUCKET}/{STATIONS_FOLDER}', str(cache_folder), '--only-show-errors'], check=True)
    runs = [read_json(path.read_bytes()) for path in sorted(cache_folder.glob('*.geojson'))]
    newest = max(parse_time(run['init_time']) for run in runs)
    return [run for run in runs if parse_time(run['init_time']) > newest - timedelta(days=days)]


def parse_time(time):
    return datetime.fromisoformat(time.replace('Z', '+00:00'))


def pm25_to_aqi(pm25):
    if pm25 is None:
        return None
    concentration = max(int(pm25 * 10) / 10, 0)
    for low_concentration, high_concentration, low_aqi, high_aqi in PM25_AQI_BREAKPOINTS:
        if concentration <= high_concentration:
            fraction = (concentration - low_concentration) / (high_concentration - low_concentration)
            return round(low_aqi + (high_aqi - low_aqi) * fraction)
    return 500


def to_reading(time, pm25):
    return {'time': time, 'pm25': pm25, 'aqi': pm25_to_aqi(pm25)}


def build_sensors(observed, runs):
    readings_by_site = defaultdict(list)
    site_by_code = {}
    for reading in observed['features']:
        properties = reading['properties']
        site_by_code[properties['aqs_code']] = reading
        readings_by_site[properties['aqs_code']].append(to_reading(properties['start_time'], properties['pm25']))

    forecasts_by_site = defaultdict(dict)
    for run in runs:
        for station in run['features']:
            forecasts_by_site[station['properties']['aqs_code']][run['init_time']] = [
                to_reading(hour['time'], hour['pm25']) for hour in station['properties']['forecast']]

    return {'type': 'FeatureCollection', 'features': [{
        'type': 'Feature',
        'geometry': site['geometry'],
        'properties': {
            'site_name': site['properties']['site_name'],
            'aqs_code': site_code,
            'agency': site['properties']['agency'],
            'observed': sorted(readings_by_site[site_code], key=lambda reading: reading['time']),
            'forecasts': forecasts_by_site[site_code],
        },
    } for site_code, site in site_by_code.items()]}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--days', type=int, default=7, help='how many days of forecast runs to keep')
    parser.add_argument('--output', type=Path, default=DATA_FOLDER / 'airnow_sensors.geojson')
    arguments = parser.parse_args()

    runs = read_recent_runs(DATA_FOLDER / 'stations-cache', arguments.days)
    sensors = build_sensors(read_from_s3(OBSERVED_KEY), runs)

    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(sensors))
    print(f"wrote {len(sensors['features'])} sensors with {len(runs)} forecast runs to {arguments.output}")


if __name__ == '__main__':
    main()
