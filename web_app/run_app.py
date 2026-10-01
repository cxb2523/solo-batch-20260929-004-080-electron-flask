import os

from app import create_app

# NOTE: Explicitly import configuration so that PyInstaller is able to find and bundle it
import config

application = create_app("config.DevelopmentConfig")

if __name__ == "__main__":
    # The Electron main process owns the lifecycle of this server: it picks a
    # free port per launch attempt and hands it over via the environment.
    port = int(os.environ.get("FLASK_PORT", "4040"))
    host = os.environ.get("FLASK_HOST", "0.0.0.0")
    # The reloader spawns a grandchild process that the main process cannot
    # supervise, so it must stay off for restarts to work reliably.
    application.run(host=host, port=port, use_reloader=False)
