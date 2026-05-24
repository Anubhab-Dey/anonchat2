cmake_minimum_required(VERSION 3.25)

project(anonchat LANGUAGES C)

set(CMAKE_C_STANDARD 23)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_executable(anonchat
    src/server.c
)

if(MSVC)
    target_compile_options(anonchat PRIVATE /W4)
else()
    target_compile_options(anonchat PRIVATE
        -Wall
        -Wextra
        -pedantic
    )
endif()

target_compile_definitions(anonchat PRIVATE
    ANONCHAT_WEB_DIR="${CMAKE_CURRENT_SOURCE_DIR}/web"
)

if(WIN32)
    target_link_libraries(anonchat PRIVATE
        websockets
        bcrypt
        sqlite3
    )
else()
    find_package(OpenSSL REQUIRED)

    target_link_libraries(anonchat PRIVATE
        websockets
        sqlite3
        OpenSSL::Crypto
    )
endif()
