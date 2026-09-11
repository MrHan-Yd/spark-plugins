//! 端口→PID:Win32 `GetExtendedTcpTable` / `GetExtendedUdpTable`(等价 netstat -ano,
//! 但无本地化文本解析问题)。只保留 LISTEN / ESTABLISHED / UDP 绑定——
//! TIME_WAIT 等临终 socket 对「关掉占用端口的进程」没有意义,不参与匹配。

use crate::procs::PortEntry;
use std::collections::{HashMap, HashSet};

const AF_INET: u32 = 2;
const AF_INET6: u32 = 23;
const TCP_STATE_LISTEN: u32 = 2;
const TCP_STATE_ESTABLISHED: u32 = 5;

/// 全系统端口表:pid → 端口条目。任何一张表查询失败都静默跳过(端口徽章缺失不致命)。
#[cfg(windows)]
pub fn port_map() -> HashMap<u32, Vec<PortEntry>> {
    let mut map: HashMap<u32, Vec<PortEntry>> = HashMap::new();
    let mut seen: HashSet<(u8, String, u16, String)> = HashSet::new();
    tcp_v4(&mut map, &mut seen);
    tcp_v6(&mut map, &mut seen);
    udp_v4(&mut map, &mut seen);
    udp_v6(&mut map, &mut seen);
    map
}

#[cfg(not(windows))]
pub fn port_map() -> HashMap<u32, Vec<PortEntry>> {
    HashMap::new()
}

/// 端口字段是网络字节序的 16 位值(存于 DWORD 低 16 位)。
#[cfg(windows)]
fn port_of(dw: u32) -> u16 {
    u16::from_be((dw & 0xffff) as u16)
}

/// IPv4 地址按网络字节序逐字节读出。
#[cfg(windows)]
fn ipv4_str(dw: u32) -> String {
    format!(
        "{}.{}.{}.{}",
        dw & 0xff,
        (dw >> 8) & 0xff,
        (dw >> 16) & 0xff,
        (dw >> 24) & 0xff
    )
}

/// 无主条目(pid=0)或纯零地址不进表。
#[cfg(windows)]
fn push_entry(
    map: &mut HashMap<u32, Vec<PortEntry>>,
    seen: &mut HashSet<(u8, String, u16, String)>,
    proto: &'static str,
    addr: String,
    port: u16,
    state: &'static str,
    pid: u32,
) {
    if pid == 0 {
        return;
    }
    let kind: u8 = if proto == "tcp" { 0 } else { 1 };
    let key = (kind, addr.clone(), port, state.to_string());
    if !seen.insert(key) {
        return;
    }
    map.entry(pid).or_default().push(PortEntry {
        proto,
        addr,
        port,
        state: state.to_string(),
    });
}

#[cfg(windows)]
fn tcp_v4(map: &mut HashMap<u32, Vec<PortEntry>>, seen: &mut HashSet<(u8, String, u16, String)>) {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    unsafe {
        let mut size: u32 = 0;
        let ret = GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if ret != ERROR_INSUFFICIENT_BUFFER || size == 0 {
            return;
        }
        let mut buf = vec![0u8; size as usize];
        let ret = GetExtendedTcpTable(
            buf.as_mut_ptr().cast(),
            &mut size,
            0,
            AF_INET,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if ret != NO_ERROR {
            return;
        }
        let table = &*(buf.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>());
        let rows = std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize);
        for r in rows {
            if r.dwState != TCP_STATE_LISTEN && r.dwState != TCP_STATE_ESTABLISHED {
                continue;
            }
            let state = if r.dwState == TCP_STATE_LISTEN {
                "LISTEN"
            } else {
                "ESTABLISHED"
            };
            push_entry(
                map,
                seen,
                "tcp",
                ipv4_str(r.dwLocalAddr),
                port_of(r.dwLocalPort),
                state,
                r.dwOwningPid,
            );
        }
    }
}

#[cfg(windows)]
fn tcp_v6(map: &mut HashMap<u32, Vec<PortEntry>>, seen: &mut HashSet<(u8, String, u16, String)>) {
    use std::net::Ipv6Addr;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6TABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    unsafe {
        let mut size: u32 = 0;
        let ret = GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET6,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if ret != ERROR_INSUFFICIENT_BUFFER || size == 0 {
            return;
        }
        let mut buf = vec![0u8; size as usize];
        let ret = GetExtendedTcpTable(
            buf.as_mut_ptr().cast(),
            &mut size,
            0,
            AF_INET6,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        );
        if ret != NO_ERROR {
            return;
        }
        let table = &*(buf.as_ptr().cast::<MIB_TCP6TABLE_OWNER_PID>());
        let rows = std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize);
        for r in rows {
            if r.dwState != TCP_STATE_LISTEN && r.dwState != TCP_STATE_ESTABLISHED {
                continue;
            }
            let state = if r.dwState == TCP_STATE_LISTEN {
                "LISTEN"
            } else {
                "ESTABLISHED"
            };
            push_entry(
                map,
                seen,
                "tcp",
                Ipv6Addr::from(r.ucLocalAddr).to_string(),
                port_of(r.dwLocalPort),
                state,
                r.dwOwningPid,
            );
        }
    }
}

#[cfg(windows)]
fn udp_v4(map: &mut HashMap<u32, Vec<PortEntry>>, seen: &mut HashSet<(u8, String, u16, String)>) {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedUdpTable, MIB_UDPTABLE_OWNER_PID, UDP_TABLE_OWNER_PID,
    };
    unsafe {
        let mut size: u32 = 0;
        let ret = GetExtendedUdpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET,
            UDP_TABLE_OWNER_PID,
            0,
        );
        if ret != ERROR_INSUFFICIENT_BUFFER || size == 0 {
            return;
        }
        let mut buf = vec![0u8; size as usize];
        let ret = GetExtendedUdpTable(
            buf.as_mut_ptr().cast(),
            &mut size,
            0,
            AF_INET,
            UDP_TABLE_OWNER_PID,
            0,
        );
        if ret != NO_ERROR {
            return;
        }
        let table = &*(buf.as_ptr().cast::<MIB_UDPTABLE_OWNER_PID>());
        let rows = std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize);
        for r in rows {
            push_entry(
                map,
                seen,
                "udp",
                ipv4_str(r.dwLocalAddr),
                port_of(r.dwLocalPort),
                "BIND",
                r.dwOwningPid,
            );
        }
    }
}

#[cfg(windows)]
fn udp_v6(map: &mut HashMap<u32, Vec<PortEntry>>, seen: &mut HashSet<(u8, String, u16, String)>) {
    use std::net::Ipv6Addr;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedUdpTable, MIB_UDP6TABLE_OWNER_PID, UDP_TABLE_OWNER_PID,
    };
    unsafe {
        let mut size: u32 = 0;
        let ret = GetExtendedUdpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET6,
            UDP_TABLE_OWNER_PID,
            0,
        );
        if ret != ERROR_INSUFFICIENT_BUFFER || size == 0 {
            return;
        }
        let mut buf = vec![0u8; size as usize];
        let ret = GetExtendedUdpTable(
            buf.as_mut_ptr().cast(),
            &mut size,
            0,
            AF_INET6,
            UDP_TABLE_OWNER_PID,
            0,
        );
        if ret != NO_ERROR {
            return;
        }
        let table = &*(buf.as_ptr().cast::<MIB_UDP6TABLE_OWNER_PID>());
        let rows = std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize);
        for r in rows {
            push_entry(
                map,
                seen,
                "udp",
                Ipv6Addr::from(r.ucLocalAddr).to_string(),
                port_of(r.dwLocalPort),
                "BIND",
                r.dwOwningPid,
            );
        }
    }
}

#[cfg(windows)]
const NO_ERROR: u32 = 0;
#[cfg(windows)]
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;