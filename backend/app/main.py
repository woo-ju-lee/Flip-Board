"""Keep the existing ASGI command compatible; desktop startup uses the factory."""
from .factory import ARCHIVES, create_app

app = create_app()
