%global plasmoid_id luisbocanegra.panel.colorizer

Name:           plasma-panel-colorizer
Version:        0.0.git.20251201  # Placeholder: Use real version or git snapshot
Release:        1%{?dist}
Summary:        Latte-Dock and WM-style panel customization for KDE Plasma panels

License:        GPLv3+
URL:            https://github.com/luisbocanegra/plasma-panel-colorizer
Source0:        %{url}/archive/%{version}/%{name}-%{version}.tar.gz  # Adjust for tag/commit

BuildArch:      %{_arch}

# Build deps: Upstream + Fedora KDE guidelines
BuildRequires:  cmake
BuildRequires:  gcc-c++
BuildRequires:  kf6-rpm-macros  # MUST for Plasma 6
BuildRequires:  extra-cmake-modules
BuildRequires:  libplasma-devel
BuildRequires:  qt6-qtbase-devel
BuildRequires:  qt6-qtdeclarative-devel
BuildRequires:  qt6-qtquickcontrols2-devel
BuildRequires:  qt6-qttools-devel
BuildRequires:  gettext
BuildRequires:  python3
BuildRequires:  python3-dbus

# Runtime: For scripts/D-Bus/previews
Requires:       plasma-workspace
Requires:       python3
Requires:       python3-dbus
Requires:       python3-gobject
Recommends:     spectacle

%description
Panel Colorizer is a fully-featured Plasma widget that brings Latte-Dock and
window manager status bar customization capabilities to the default KDE Plasma
panels. It provides advanced control over panel background, widget islands,
shadows, blur, spacing, and text/icon colors, along with preset management and
D-Bus integration for automation.

%prep
%autosetup -n %{name}-%{version}

%build
# Generate translations (upstream kpac)
python3 ./kpac i18n --no-merge

# Plasma 6 CMake (KDE guideline)
%cmake_kf6 \
    -DINSTALL_PLASMOID=ON \
    -DBUILD_PLUGIN=ON \
    -DBUILD_TESTING=OFF

%cmake_build

# Find translations for packaging
%find_lang %{name} --all-name

%install
%cmake_install
# Dedupe if needed
%fdupes %{buildroot}

# Scripts must be executable (upstream/AUR)
chmod 0755 %{buildroot}%{_datadir}/plasma/plasmoids/%{plasmoid_id}/contents/ui/tools/list_presets.sh
chmod 0755 %{buildroot}%{_datadir}/plasma/plasmoids/%{plasmoid_id}/contents/ui/tools/gdbus_get_signal.sh

%files -f %{name}.lang
%license LICENSE
%doc README.md CHANGELOG.md

# Plasmoid
%{_datadir}/plasma/plasmoids/%{plasmoid_id}/

# C++ QML plugin
%{_libdir}/qt6/qml/org/kde/plasma/panelcolorizer/

# Services (Plasma 6 only)
%{_datadir}/kservices6/*panelcolorizer*.desktop

%changelog
* Sun Dec 01 2025 Peridot Augustus <dpierce82@gmail.com> - 0.0.git.20251201-1
- Initial COPR packaging for plasma-panel-colorizer (Plasma 6)
