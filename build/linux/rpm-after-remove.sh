#!/bin/bash

# rpm runs the old package's removal script after the new package's install script, so without this
# guard every upgrade would delete the link and AppArmor profile the new version just set up.
if [ "$1" -ge 1 ]; then
  exit 0
fi

if type update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
  rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE='/etc/apparmor.d/${executable}'
if [ -f "$APPARMOR_PROFILE" ]; then
  if apparmor_status --enabled >/dev/null 2>&1 && hash apparmor_parser 2>/dev/null; then
    apparmor_parser --remove "$APPARMOR_PROFILE" || true
  fi
  rm -f "$APPARMOR_PROFILE"
fi
