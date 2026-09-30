from app import create_app

# NOTE: Explicitly import configuration so that PyInstaller is able to find and bundle it
import config
import os

application = create_app("config.DevelopmentConfig")

if __name__ == "__main__":
    host = os.getenv("FLASK_HOST", "127.0.0.1")
    port = int(os.getenv("FLASK_PORT", "4040"))
    application.run(host=host, port=port, use_reloader=False)
