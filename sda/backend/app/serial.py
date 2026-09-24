"""Making DuckDB values safe to put in JSON.

DuckDB hands back Decimal, date, datetime, timedelta, UUID, bytes and nested
lists/structs. Most of those are not JSON-serialisable, and the ones that are
convertible must not be converted carelessly: a DECIMAL turned into a float
loses exactness, which for money columns is the kind of bug nobody notices
until a total is off by a cent. Decimals go out as strings.
"""

import datetime as dt
import decimal
import math


def jsonable(v):
    if v is None or isinstance(v, (bool, str, int)):
        return v
    if isinstance(v, float):
        # JSON has no NaN/Infinity. Emitting them produces invalid JSON that
        # some clients accept and others reject; null is honest.
        return v if math.isfinite(v) else None
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v).hex()
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [jsonable(x) for x in v]
    # timedelta, UUID and anything else DuckDB adds: its text form.
    return str(v)


def rows_to_json(rows):
    return [[jsonable(c) for c in row] for row in rows]


def result_to_json(result):
    return {"columns": list(result.columns), "types": list(result.types),
            "rows": rows_to_json(result.rows)}
