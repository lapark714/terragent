"""Terragent imagery pipeline: free Sentinel-2 / Landsat scenes from Planetary Computer -> AnalysisResult JSON.

CLI contract: docs/ARCHITECTURE.md §10. Output shape: AnalysisResult in src/lib/domain.ts.
"""
import os

# GDAL settings for COG reads over HTTPS, set before any submodule loads rasterio:
# don't list sidecar files, retry flaky range requests, never hang on a dead connection.
for _key, _value in {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif,.TIF,.tiff",
    "GDAL_HTTP_MAX_RETRY": "3",
    "GDAL_HTTP_RETRY_DELAY": "1",
    "GDAL_HTTP_TIMEOUT": "30",
}.items():
    os.environ.setdefault(_key, _value)
