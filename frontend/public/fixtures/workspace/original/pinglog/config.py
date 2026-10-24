import tomllib
from pydantic import BaseModel, validator


class Site(BaseModel):
    name: str
    url: str

    class Config:
        anystr_strip_whitespace = True

    @validator("url")
    def url_has_scheme(cls, value):
        return value


def load_settings(path="sites.toml"):
    with open(path, "rb") as f:
        data = tomllib.load(f)
    return data
