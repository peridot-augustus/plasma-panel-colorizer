%global plasmoid_id luisbocanegra.panel.colorizer

Name:           plasma-panel-colorizer
Version:        5.6.0
Release:        1%{?dist}
Summary:        Latte-Dock and WM-style panel customization for KDE Plasma panels

License:        GPLv3+
URL:            https://github.com/luisbocanegra/plasma-panel-colorizer
Source0:        %{url}/archive/refs/tags/v%{version}.tar.gz

BuildArch:      %{_arch}

BuildRequires:  cmake
BuildRequires:  gcc-c++
BuildRequires:  kf6-rpm-macros
BuildRequires:  extra-cmake-modules
BuildRequires:  libplasma-devel
BuildRequires:  qt6-qtbase-devel
BuildRequires:  qt6-qtdeclarative-devel
BuildRequires:  qt6-qtquickcontrols2-devel
BuildRequires:  qt6-qttools-devel
BuildRequires:  gettext
BuildRequires:  python3
BuildRequires:  python3-dbus

Requires:       plasma-workspace
Requires:       python3
Requires:       python3-dbus
Requires:       python3-gobject
Recommends:     spectacle

%description
Panel Colorizer is a Plasma widget that brings Latte-Dock and window manager status bar customization capabilities to the default KDE Plasma panels. It provides advanced control over panel background, widget islands, shadows, blur, spacing, and text or icon colors, along with preset management and D-Bus integration for automation.

%prep
%autosetup -n %{name}-%{version}

%build
python3 ./kpac i18n --no-merge

%cmake_kf6 \
    -DINSTALL_PLASMOID=ON \
    -DBUILD_PLUGIN=ON \
    -DBUILD_TESTING=OFF

%cmake_build

%install
%cmake_install

if [ -f %{buildroot}%{_datadir}/plasma/plasmoids/%{plasmoid_id}/contents/ui/tools/list_presets.sh ]; then \
    chmod 0755 %{buildroot}%{_datadir}/plasma/plasmoids/%{plasmoid_id}/contents/ui/tools/list_presets.sh; \
fi
if [ -f %{buildroot}%{_datadir}/plasma/plasmoids/%{plasmoid_id}/contents/ui/tools/gdbus_get_signal.sh ]; then \
    chmod 0755 %{buildroot}%{_datadir}/plasma/plasmoids/%{plasmoid_id}/contents/ui/tools/gdbus_get_signal.sh; \
fi

%files
%license LICENSE
%doc README.md CHANGELOG.md
%{_datadir}/plasma/plasmoids/%{plasmoid_id}/
%{_libdir}/qt6/qml/org/kde/plasma/panelcolorizer/

%changelog
* Mon Dec  1 2025 Peridot Augustus <dpierce82@gmail.com> - 5.6.0-1
- Initial COPR packaging for plasma-panel-colorizer
